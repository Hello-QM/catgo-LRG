import { readFileSync } from 'node:fs'
import { resolve as resolve_path } from 'node:path'
import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  capture_camera_pose,
  mutate_camera_pose,
  notify_camera_pose_change,
} from '$lib/structure/rendering/camera-revision'

const STRUCTURE_SOURCE = readFileSync(
  resolve_path(process.cwd(), `src/lib/structure/Structure.svelte`),
  `utf8`,
)
const SCENE_SOURCE = readFileSync(
  resolve_path(process.cwd(), `src/lib/structure/StructureScene.svelte`),
  `utf8`,
)

function camera_fixture() {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, -10, 0)
  camera.up.set(0, 0, 1)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  return { camera, target: new Vector3(0, 0, 0) }
}

/**
 * Extract a named function body with brace balancing. These production
 * contracts intentionally supplement (rather than replace) the executable
 * helper tests below.
 */
function function_body(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`)
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf(`{`, start)
  let depth = 0
  for (let idx = open; idx < source.length; idx += 1) {
    if (source[idx] === `{`) depth += 1
    else if (source[idx] === `}`) {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, idx)
    }
  }
  throw new Error(`unterminated function ${name}`)
}

function between(source: string, start_marker: string, end_marker: string): string {
  const start = source.indexOf(start_marker)
  expect(start, `missing start marker: ${start_marker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(end_marker, start + start_marker.length)
  expect(end, `missing end marker: ${end_marker}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe(`camera revision mutation helper`, () => {
  it(`does not notify for a true no-op`, () => {
    const { camera, target } = camera_fixture()
    const notify = vi.fn()
    const before = capture_camera_pose(camera, target)

    expect(notify_camera_pose_change(before, camera, target, notify)).toBe(false)
    expect(notify).not.toHaveBeenCalled()

    expect(mutate_camera_pose(camera, target, () => {
      camera.position.copy(camera.position)
      target.copy(target)
      camera.updateMatrixWorld(true)
    }, notify)).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it(`notifies once, after a compound camera/target mutation has landed`, () => {
    const { camera, target } = camera_fixture()
    const observations: Array<{
      position: number[]
      target: number[]
      up: number[]
    }> = []

    const changed = mutate_camera_pose(camera, target, () => {
      camera.position.set(3, -4, 5)
      camera.up.set(0, 1, 0)
      target.set(1, 2, 3)
      camera.lookAt(target)
      camera.updateMatrixWorld(true)
    }, () => {
      observations.push({
        position: camera.position.toArray(),
        target: target.toArray(),
        up: camera.up.toArray(),
      })
    })

    expect(changed).toBe(true)
    expect(observations).toEqual([{
      position: [3, -4, 5],
      target: [1, 2, 3],
      up: [0, 1, 0],
    }])
  })

  it.each([
    [`position`, (camera: PerspectiveCamera, _target: Vector3) => camera.position.x += 1],
    [`target`, (_camera: PerspectiveCamera, target: Vector3) => target.y += 1],
    [`up`, (camera: PerspectiveCamera, _target: Vector3) => camera.up.set(0, 1, 0)],
    [`quaternion`, (camera: PerspectiveCamera, _target: Vector3) => camera.rotateZ(0.2)],
    [`zoom`, (camera: PerspectiveCamera, _target: Vector3) => camera.zoom = 1.5],
  ])(`detects a changed %s field`, (_label, mutate) => {
    const { camera, target } = camera_fixture()
    const notify = vi.fn()
    const before = capture_camera_pose(camera, target)
    mutate(camera, target)

    expect(notify_camera_pose_change(before, camera, target, notify)).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe(`camera revision production bridges`, () => {
  it(`routes direct gestures, MediaPipe pan, reset, and axis views through the shared helper`, () => {
    expect(STRUCTURE_SOURCE).toContain(
      `from './rendering/camera-revision'`,
    )
    const rotate = between(
      STRUCTURE_SOURCE,
      `rotate(axis, angle) {`,
      `zoom(delta) {`,
    )
    expect(rotate).toContain(`mutate_camera_pose(`)
    const fallback = rotate.slice(rotate.indexOf(`// Fallback: rotate the scene directly`))
    expect(fallback).not.toContain(`note_scene_camera_change(`)

    const media_pipe_pan = between(
      function_body(STRUCTURE_SOURCE, `on_gesture`),
      `if (event.action === \`pan\` && orbit_controls && camera) {`,
      `// Scale screen_pos from normalized`,
    )
    expect(media_pipe_pan.indexOf(`if (!grab_hand) {`)).toBeLessThan(
      media_pipe_pan.indexOf(`mutate_camera_pose(`),
    )
    expect(media_pipe_pan).toContain(`mutate_camera_pose(`)

    expect(function_body(STRUCTURE_SOURCE, `reset_camera`)).toContain(
      `mutate_camera_pose(`,
    )
    expect(function_body(STRUCTURE_SOURCE, `set_view_direction`)).toContain(
      `mutate_camera_pose(`,
    )
  })

  it(`bridges target, async pose, reset-up, and gizmo mutations at their final pose`, () => {
    const apply_target = function_body(SCENE_SOURCE, `apply_orbit_target`)
    expect(apply_target).toContain(`mutate_camera_pose(`)
    expect(apply_target.indexOf(`current_camera_target = copy_vec3(target)`)).toBeLessThan(
      apply_target.indexOf(`}, () => {`),
    )
    expect(apply_target.indexOf(`sync_trackball_reset_refs()`)).toBeLessThan(
      apply_target.indexOf(`}, () => {`),
    )

    const initial_up = between(
      SCENE_SOURCE,
      `// Set camera.up to Z-axis once camera + controls are both ready.`,
      `// Lock the rotation pivot on initial structure load or explicit recenter.`,
    )
    expect(initial_up.indexOf(`orbit_controls!.update?.()`)).toBeLessThan(
      initial_up.indexOf(`finish_camera_change(`),
    )
    expect(initial_up).toContain(`revision_before`)

    const lattice_align = between(
      SCENE_SOURCE,
      `// Reset camera to default +Z viewing direction`,
      `// Restore the view when the projection type changes`,
    )
    expect(lattice_align).toContain(`requestAnimationFrame(() => {`)
    expect(lattice_align.indexOf(`orbit_controls!.update()`)).toBeLessThan(
      lattice_align.indexOf(`finish_camera_change(`),
    )

    const projection_restore = between(
      SCENE_SOURCE,
      `// Restore the view when the projection type changes`,
      `// Re-apply orbit target when component becomes visible again`,
    )
    expect(projection_restore).toContain(
      `requestAnimationFrame(() => requestAnimationFrame(() => {`,
    )
    expect(projection_restore.indexOf(`orbit_controls!.update?.()`)).toBeLessThan(
      projection_restore.indexOf(`finish_camera_change(`),
    )

    const reset_up = between(
      SCENE_SOURCE,
      `// Reset camera.up to [0,0,1]`,
      `// Track initial computed zoom for reset`,
    )
    expect(reset_up.indexOf(`ctrl.update()`)).toBeLessThan(
      reset_up.indexOf(`finish_camera_change(`),
    )

    const gizmo = function_body(SCENE_SOURCE, `handle_gizmo_end`)
    expect(gizmo.indexOf(`orbit_controls!.update()`)).toBeLessThan(
      gizmo.indexOf(`finish_camera_change(`),
    )
  })

  it(`publishes declarative camera inputs without coupling runtime clipping maintenance to revisions`, () => {
    const publisher = SCENE_SOURCE.slice(
      SCENE_SOURCE.indexOf(`let visual_revision = 0`),
      SCENE_SOURCE.indexOf(`onDestroy(() =>`, SCENE_SOURCE.indexOf(`let visual_revision = 0`)),
    )
    for (const dependency of [
      `camera_position[0]`,
      `camera_position[1]`,
      `camera_position[2]`,
      `computed_zoom`,
      `fov`,
      `camera_near`,
      `camera_far`,
    ]) {
      expect(publisher).toContain(dependency)
    }

    const clipping_task = SCENE_SOURCE.slice(
      SCENE_SOURCE.indexOf(`// Dynamic near/far adjustment`),
      SCENE_SOURCE.indexOf(`// Pixels-per-Angstrom`, SCENE_SOURCE.indexOf(`// Dynamic near/far adjustment`)),
    )
    expect(clipping_task).not.toContain(`note_camera_change`)
    expect(clipping_task).not.toContain(`camera_revision`)
  })
})
