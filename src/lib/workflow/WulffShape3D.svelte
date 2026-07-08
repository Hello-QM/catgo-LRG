<script lang="ts">
  /**
   * Wulff Shape 3D — interactive 3D nanoparticle polyhedron using Plotly mesh3d.
   *
   * Renders the Wulff equilibrium shape as a colored 3D mesh with Miller index
   * labels. Uses Plotly instead of Threlte for reliable rendering inside the
   * workflow status panel sidebar.
   *
   * Key implementation notes:
   * - Plotly is loaded once and cached in a module-level variable (NOT $state)
   *   to avoid Svelte 5 proxy wrapping of the massive Plotly object.
   * - facets_3d prop data is JSON-cloned before processing to escape
   *   Svelte proxy objects that can interfere with deep iteration.
   * - Layout uses explicit width measured from the container to avoid
   *   Plotly 3D scene sizing issues with responsive mode.
   */
  import { lazy_load_plotly, make_target_writable, base_config, observe_resize } from './plotly-utils'
  import { download } from '$lib/io/fetch'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { untrack } from 'svelte'

  interface WulffFacet3D {
    miller: string
    normal: number[]
    e_surf: number
    triangles: number[][][]
    centroid: number[]
  }

  let {
    facets_3d = [],
    height = 350,
  }: {
    facets_3d: WulffFacet3D[]
    height?: number
  } = $props()

  load_i18n_module('workflow')

  let plot_div: HTMLDivElement | undefined = $state()

  // Module-level Plotly ref — NOT reactive, avoids proxy overhead
  let _Plotly: any = null
  let _plotly_ready = $state(false)

  // Color scale: green (low gamma) -> red (high gamma), matching WulffPlot
  function facet_color(e_surf: number, min_e: number, max_e: number): string {
    const range = max_e - min_e || 1
    const t = (e_surf - min_e) / range
    const r = Math.round(34 + t * 205)
    const g = Math.round(197 - t * 128)
    const b = Math.round(94 - t * 50)
    return `rgb(${r}, ${g}, ${b})`
  }

  // Load Plotly once
  $effect(() => {
    if (typeof window === 'undefined') return
    if (_Plotly) { _plotly_ready = true; return }
    lazy_load_plotly().then((p) => {
      _Plotly = p
      _plotly_ready = true
    })
  })

  // Main render effect — deferred to next frame so container has layout dimensions
  let _render_raf = 0
  $effect(() => {
    // Read reactive deps first to register them
    const ready = _plotly_ready
    const div = plot_div
    const data = facets_3d
    const h = height

    if (!ready || !_Plotly || !div || !data.length) return

    // Deep-clone to escape Svelte proxy — ensures plain arrays/objects
    // are passed to the vertex processing and ultimately to Plotly
    const plain_facets: WulffFacet3D[] = JSON.parse(JSON.stringify(data))

    // Defer render to next animation frame so the container element has
    // been laid out by the browser and clientWidth/clientHeight are accurate.
    // Without this, Plotly may render the 3D scene at 0-width, producing
    // thin slivers instead of a solid polyhedron.
    cancelAnimationFrame(_render_raf)
    _render_raf = requestAnimationFrame(() => {
      untrack(() => {
        render_plot(_Plotly, div, plain_facets, h)
      })
    })

    return () => {
      cancelAnimationFrame(_render_raf)
      if (div && _Plotly) _Plotly.purge(div)
    }
  })

  function render_plot(Plotly: any, div: HTMLDivElement, facets: WulffFacet3D[], h: number) {
    const e_surfs = facets.map(f => f.e_surf)
    const min_e = Math.min(...e_surfs)
    const max_e = Math.max(...e_surfs)

    // Collect all raw vertices to compute normalization scale
    const raw_verts: number[][] = []
    for (const facet of facets) {
      for (const tri of facet.triangles) {
        for (const v of tri) raw_verts.push(v)
      }
    }
    // Normalize: center at origin, uniform scale so max extent = 2
    let cx = 0, cy = 0, cz = 0
    for (const v of raw_verts) { cx += v[0]; cy += v[1]; cz += v[2] }
    const n = raw_verts.length || 1
    cx /= n; cy /= n; cz /= n
    let max_extent = 0
    for (const v of raw_verts) {
      max_extent = Math.max(max_extent, Math.abs(v[0] - cx), Math.abs(v[1] - cy), Math.abs(v[2] - cz))
    }
    const scale = max_extent > 0 ? 1.0 / max_extent : 1.0
    function norm(v: number[]): number[] {
      return [(v[0] - cx) * scale, (v[1] - cy) * scale, (v[2] - cz) * scale]
    }

    // Build indexed mesh: deduplicate vertices, collect triangle indices + per-face colors
    const vert_map = new Map<string, number>()
    const verts_x: number[] = []
    const verts_y: number[] = []
    const verts_z: number[] = []
    const tri_i: number[] = []
    const tri_j: number[] = []
    const tri_k: number[] = []
    const face_colors: string[] = []

    function vert_idx(v: number[]): number {
      const nv = norm(v)
      const key = `${nv[0].toFixed(6)},${nv[1].toFixed(6)},${nv[2].toFixed(6)}`
      if (vert_map.has(key)) return vert_map.get(key)!
      const idx = verts_x.length
      vert_map.set(key, idx)
      verts_x.push(nv[0])
      verts_y.push(nv[1])
      verts_z.push(nv[2])
      return idx
    }

    for (const facet of facets) {
      const color = facet_color(facet.e_surf, min_e, max_e)
      for (const tri of facet.triangles) {
        const a = tri[0], b = tri[1], c = tri[2]
        const i0 = vert_idx(a), i1 = vert_idx(b), i2 = vert_idx(c)

        // Ensure outward-facing winding: cross product should point away from origin
        const e1x = b[0]-a[0], e1y = b[1]-a[1], e1z = b[2]-a[2]
        const e2x = c[0]-a[0], e2y = c[1]-a[1], e2z = c[2]-a[2]
        const nx = e1y*e2z - e1z*e2y
        const ny = e1z*e2x - e1x*e2z
        const nz = e1x*e2y - e1y*e2x
        // Centroid of triangle — dot with normal should be positive (outward)
        const cx = (a[0]+b[0]+c[0])/3
        const cy = (a[1]+b[1]+c[1])/3
        const cz = (a[2]+b[2]+c[2])/3
        const dot = nx*cx + ny*cy + nz*cz

        if (dot >= 0) {
          tri_i.push(i0); tri_j.push(i1); tri_k.push(i2)
        } else {
          tri_i.push(i0); tri_j.push(i2); tri_k.push(i1)
        }
        face_colors.push(color)
      }
    }

    // Mesh3d trace
    const mesh: any = {
      type: 'mesh3d',
      x: verts_x, y: verts_y, z: verts_z,
      i: tri_i, j: tri_j, k: tri_k,
      facecolor: face_colors,
      flatshading: true,
      opacity: 1,
      lighting: { ambient: 0.6, diffuse: 0.8, specular: 0.3, roughness: 0.5 },
      lightposition: { x: 1000, y: 1000, z: 1000 },
      hoverinfo: 'skip',
      showscale: false,
    }

    // Deduplicated Miller labels as scatter3d text (use normalized coordinates)
    const label_map = new Map<string, { x: number; y: number; z: number; dist: number }>()
    for (const facet of facets) {
      const nc = norm(facet.centroid)
      const mag = Math.hypot(nc[0], nc[1], nc[2])
      const prev = label_map.get(facet.miller)
      if (!prev || mag > prev.dist) {
        label_map.set(facet.miller, {
          x: nc[0] * 1.3, y: nc[1] * 1.3, z: nc[2] * 1.3,
          dist: mag,
        })
      }
    }
    const labels = [...label_map.entries()]
    const label_trace: any = {
      type: 'scatter3d',
      x: labels.map(([, d]) => d.x),
      y: labels.map(([, d]) => d.y),
      z: labels.map(([, d]) => d.z),
      mode: 'text',
      text: labels.map(([m]) => `(${m})`),
      textfont: { size: 12, color: '#e5e7eb', family: 'SF Mono, monospace' },
      hoverinfo: 'skip',
      showlegend: false,
    }

    // Compute axis range from vertices
    const pad = 0.5
    const all_coords = [...verts_x, ...verts_y, ...verts_z]
    const lo = Math.min(...all_coords) - pad
    const hi = Math.max(...all_coords) + pad

    // Measure container width for explicit sizing (avoids 3D scene squishing)
    const container_width = div.parentElement?.clientWidth || div.clientWidth || 400

    const layout: any = {
      width: container_width,
      height: h,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      scene: {
        xaxis: { visible: false, range: [lo, hi] },
        yaxis: { visible: false, range: [lo, hi] },
        zaxis: { visible: false, range: [lo, hi] },
        aspectmode: 'cube',
        aspectratio: { x: 1, y: 1, z: 1 },
        camera: { eye: { x: 1.5, y: 1.0, z: 0.8 } },
        bgcolor: 'rgba(0,0,0,0)',
      },
      showlegend: false,
    }

    Plotly.react(div, [mesh, label_trace], layout, {
      ...base_config(),
      scrollZoom: true,
    })
  }

  $effect(() => {
    if (!plot_div) return
    plot_div.addEventListener('mousemove', make_target_writable, true)
    const stop_resize = observe_resize(plot_div)
    return () => {
      plot_div?.removeEventListener('mousemove', make_target_writable, true)
      stop_resize()
    }
  })

  export async function export_plot(format: 'png' | 'svg') {
    if (!_Plotly || !plot_div) return
    const url = await _Plotly.toImage(plot_div, { format, width: 800, height: 800, scale: 2 })
    const blob = await (await fetch(url)).blob()
    download(blob, `wulff_3d.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

{#if facets_3d.length > 0}
  <div class="wulff-3d-container">
    <div bind:this={plot_div} class="wulff-3d-plot"></div>
    <div class="export-bar">
      <button class="export-btn" onclick={() => export_plot('png')} title={t('workflow.wulff_export_png')}>PNG</button>
      <button class="export-btn" onclick={() => export_plot('svg')} title={t('workflow.wulff_export_svg')}>SVG</button>
    </div>
  </div>
{:else}
  <div class="no-data">{t('workflow.wulff_no_3d_data')}</div>
{/if}

<style>
  .wulff-3d-container {
    width: 100%;
    position: relative;
    margin-top: 8px;
  }
  .wulff-3d-plot {
    width: 100%;
    min-height: 280px;
  }
  .export-bar {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    padding: 4px 0;
  }
  .export-btn {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid rgba(128, 128, 128, 0.3);
    background: rgba(128, 128, 128, 0.1);
    color: var(--text-color, #ccc);
    cursor: pointer;
  }
  .export-btn:hover {
    background: rgba(128, 128, 128, 0.25);
  }
  .no-data {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: rgba(255, 255, 255, 0.4);
    font-size: 12px;
  }
</style>
