import type { ResolvedVisualState } from '$lib/structure/rendering/visual-state'

export const atom_visual_snapshots: ResolvedVisualState[] = []
export const combined_visual_snapshots: ResolvedVisualState[] = []

export function record_atom_visual_snapshot(
  snapshot: ResolvedVisualState,
): void {
  atom_visual_snapshots.push(snapshot)
}

export function record_combined_visual_snapshot(
  snapshot: ResolvedVisualState,
): void {
  combined_visual_snapshots.push(snapshot)
}

export function reset_structure_scene_visual_captures(): void {
  atom_visual_snapshots.length = 0
  combined_visual_snapshots.length = 0
}
