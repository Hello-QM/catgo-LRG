<script lang="ts">
  /**
   * 3D Cutting Plane Visualizer for Miller Slab Cutter
   *
   * Renders:
   * - Semi-transparent cutting plane with grid pattern
   * - Normal direction arrow
   * - Thickness region (when thickness > 0)
   * - Scan line animation effect
   * - Labels showing (hkl), offset, thickness
   */
  import type { Vec3 } from '$lib'
  import { T } from '@threlte/core'
  import * as extras from '@threlte/extras'
  import { Quaternion, Vector3 } from 'three'

  let {
    normal = [0, 0, 1] as Vec3,
    offset = 0,
    thickness = 0,
    plane_size = 20,
    miller_label = '(001)',
    show_labels = true,
    show_arrow = true,
    show_scan_line = true,
    scan_line_speed = 2,
    plane_color = '#4488ff',
    arrow_color = '#ff4444',
    flash_intensity = 0,  // 0-1 for apply flash effect
  }: {
    normal?: Vec3
    offset?: number
    thickness?: number
    plane_size?: number
    miller_label?: string
    show_labels?: boolean
    show_arrow?: boolean
    show_scan_line?: boolean
    scan_line_speed?: number
    plane_color?: string
    arrow_color?: string
    flash_intensity?: number
  } = $props()

  // Animation state
  let scan_line_offset = $state(0)
  let time = $state(0)

  // Animate scan line
  $effect(() => {
    if (!show_scan_line) return

    let frame_id = 0
    const animate = () => {
      time += 0.016 // ~60fps
      scan_line_offset = (Math.sin(time * scan_line_speed) + 1) / 2
      frame_id = requestAnimationFrame(animate)
    }
    frame_id = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame_id)
  })

  // Calculate plane center position
  let plane_center = $derived<Vec3>([
    normal[0] * offset,
    normal[1] * offset,
    normal[2] * offset
  ])

  // Upper and lower plane positions for thickness visualization
  let upper_offset = $derived(offset + thickness / 2)
  let lower_offset = $derived(offset - thickness / 2)

  let upper_center = $derived<Vec3>([
    normal[0] * upper_offset,
    normal[1] * upper_offset,
    normal[2] * upper_offset
  ])

  let lower_center = $derived<Vec3>([
    normal[0] * lower_offset,
    normal[1] * lower_offset,
    normal[2] * lower_offset
  ])

  // Calculate rotation to align plane with normal
  let plane_rotation = $derived.by(() => {
    const up = new Vector3(0, 0, 1)
    const norm = new Vector3(...normal)
    const quat = new Quaternion().setFromUnitVectors(up, norm)
    return [quat.x, quat.y, quat.z, quat.w] as [number, number, number, number]
  })

  // Arrow end position (extending from plane center along normal)
  let arrow_length = $derived(Math.max(3, plane_size * 0.3))
  let arrow_end = $derived<Vec3>([
    plane_center[0] + normal[0] * arrow_length,
    plane_center[1] + normal[1] * arrow_length,
    plane_center[2] + normal[2] * arrow_length
  ])

  // Label position (offset from plane)
  let label_offset = $derived<Vec3>([
    plane_center[0] + normal[0] * (arrow_length + 1),
    plane_center[1] + normal[1] * (arrow_length + 1),
    plane_center[2] + normal[2] * (arrow_length + 1)
  ])

  // Grid pattern using line segments
  let grid_lines = $derived.by(() => {
    const lines: { from: Vec3; to: Vec3 }[] = []
    const half = plane_size / 2
    const step = plane_size / 10

    // Create grid in local XY, will be rotated by quaternion
    for (let i = -half; i <= half; i += step) {
      // Lines parallel to X
      lines.push({
        from: [-half, i, 0],
        to: [half, i, 0]
      })
      // Lines parallel to Y
      lines.push({
        from: [i, -half, 0],
        to: [i, half, 0]
      })
    }

    return lines
  })

  // Calculate plane opacity with flash effect
  let plane_opacity = $derived(0.15 + flash_intensity * 0.5)
  let grid_opacity = $derived(0.4 + flash_intensity * 0.4)

  // Scan line position in local coordinates
  let scan_y = $derived((scan_line_offset - 0.5) * plane_size)
</script>

<!-- Main cutting plane -->
<T.Group position={plane_center} quaternion={plane_rotation}>
  <!-- Semi-transparent plane surface -->
  <T.Mesh>
    <T.PlaneGeometry args={[plane_size, plane_size]} />
    <T.MeshBasicMaterial
      color={plane_color}
      transparent
      opacity={plane_opacity}
      side={2}
      depthWrite={false}

    />
  </T.Mesh>

  <!-- Grid lines -->
  {#each grid_lines as line (line.from.join(',') + line.to.join(','))}
    <T.Line>
      <T.BufferGeometry>
        <T.Float32BufferAttribute
          attach="attributes.position"
          args={[new Float32Array([...line.from, ...line.to]), 3]}
        />
      </T.BufferGeometry>
      <T.LineBasicMaterial
        color={plane_color}
        transparent
        opacity={grid_opacity}
        linewidth={1}
      />
    </T.Line>
  {/each}

  <!-- Scan line effect -->
  {#if show_scan_line}
    <T.Mesh position={[0, scan_y, 0.01]}>
      <T.PlaneGeometry args={[plane_size, 0.3]} />
      <T.MeshBasicMaterial
        color="#ffffff"
        transparent
        opacity={0.6}
        depthWrite={false}
  
      />
    </T.Mesh>
  {/if}

  <!-- Border outline -->
  <T.Line>
    <T.BufferGeometry>
      <T.Float32BufferAttribute
        attach="attributes.position"
        args={[new Float32Array([
          -plane_size/2, -plane_size/2, 0,
          plane_size/2, -plane_size/2, 0,
          plane_size/2, plane_size/2, 0,
          -plane_size/2, plane_size/2, 0,
          -plane_size/2, -plane_size/2, 0,
        ]), 3]}
      />
    </T.BufferGeometry>
    <T.LineBasicMaterial
      color={plane_color}
      transparent
      opacity={0.8 + flash_intensity * 0.2}
      linewidth={2}
    />
  </T.Line>
</T.Group>

<!-- Thickness visualization: upper and lower planes -->
{#if thickness > 0}
  <!-- Upper bound plane -->
  <T.Group position={upper_center} quaternion={plane_rotation}>
    <T.Mesh>
      <T.PlaneGeometry args={[plane_size, plane_size]} />
      <T.MeshBasicMaterial
        color="#44ff88"
        transparent
        opacity={0.08}
        side={2}
        depthWrite={false}
  
      />
    </T.Mesh>
    <!-- Dashed border -->
    <T.Line>
      <T.BufferGeometry>
        <T.Float32BufferAttribute
          attach="attributes.position"
          args={[new Float32Array([
            -plane_size/2, -plane_size/2, 0,
            plane_size/2, -plane_size/2, 0,
            plane_size/2, plane_size/2, 0,
            -plane_size/2, plane_size/2, 0,
            -plane_size/2, -plane_size/2, 0,
          ]), 3]}
        />
      </T.BufferGeometry>
      <T.LineDashedMaterial
        color="#44ff88"
        transparent
        opacity={0.5}
        dashSize={0.5}
        gapSize={0.3}
      />
    </T.Line>
  </T.Group>

  <!-- Lower bound plane -->
  <T.Group position={lower_center} quaternion={plane_rotation}>
    <T.Mesh>
      <T.PlaneGeometry args={[plane_size, plane_size]} />
      <T.MeshBasicMaterial
        color="#ff8844"
        transparent
        opacity={0.08}
        side={2}
        depthWrite={false}
  
      />
    </T.Mesh>
    <!-- Dashed border -->
    <T.Line>
      <T.BufferGeometry>
        <T.Float32BufferAttribute
          attach="attributes.position"
          args={[new Float32Array([
            -plane_size/2, -plane_size/2, 0,
            plane_size/2, -plane_size/2, 0,
            plane_size/2, plane_size/2, 0,
            -plane_size/2, plane_size/2, 0,
            -plane_size/2, -plane_size/2, 0,
          ]), 3]}
        />
      </T.BufferGeometry>
      <T.LineDashedMaterial
        color="#ff8844"
        transparent
        opacity={0.5}
        dashSize={0.5}
        gapSize={0.3}
      />
    </T.Line>
  </T.Group>

  <!-- Connecting edges between upper and lower planes -->
  {#each [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [sx, sy]}
    {@const half = plane_size / 2}
    <T.Line>
      <T.BufferGeometry>
        <T.Float32BufferAttribute
          attach="attributes.position"
          args={[new Float32Array([
            lower_center[0] + sx * half * (1 - normal[0] * normal[0]),
            lower_center[1] + sy * half * (1 - normal[1] * normal[1]),
            lower_center[2],
            upper_center[0] + sx * half * (1 - normal[0] * normal[0]),
            upper_center[1] + sy * half * (1 - normal[1] * normal[1]),
            upper_center[2],
          ]), 3]}
        />
      </T.BufferGeometry>
      <T.LineDashedMaterial
        color="#888888"
        transparent
        opacity={0.3}
        dashSize={0.3}
        gapSize={0.2}
      />
    </T.Line>
  {/each}
{/if}

<!-- Normal direction arrow -->
{#if show_arrow}
  <!-- Arrow shaft -->
  <T.Line>
    <T.BufferGeometry>
      <T.Float32BufferAttribute
        attach="attributes.position"
        args={[new Float32Array([...plane_center, ...arrow_end]), 3]}
      />
    </T.BufferGeometry>
    <T.LineBasicMaterial color={arrow_color} linewidth={3} />
  </T.Line>

  <!-- Arrow head (cone) -->
  <T.Group position={arrow_end}>
    {@const cone_quat = (() => {
      const up = new Vector3(0, 1, 0)
      const dir = new Vector3(...normal)
      return new Quaternion().setFromUnitVectors(up, dir)
    })()}
    <T.Mesh quaternion={[cone_quat.x, cone_quat.y, cone_quat.z, cone_quat.w]}>
      <T.ConeGeometry args={[0.3, 0.8, 8]} />
      <T.MeshBasicMaterial color={arrow_color} />
    </T.Mesh>
  </T.Group>
{/if}

<!-- Labels -->
{#if show_labels}
  <extras.HTML center position={label_offset}>
    <div class="plane-label">
      <span class="miller">{miller_label}</span>
      <span class="offset">d = {offset.toFixed(2)} A</span>
      {#if thickness > 0}
        <span class="thickness">t = {thickness.toFixed(2)} A</span>
      {/if}
    </div>
  </extras.HTML>
{/if}

<style>
  .plane-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    background: rgba(0, 0, 0, 0.75);
    color: white;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-family: monospace;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .miller {
    font-size: 14px;
    font-weight: bold;
    color: var(--accent-color);
  }

  .offset {
    color: var(--text-color-muted);
  }

  .thickness {
    color: var(--success-color);
  }
</style>
