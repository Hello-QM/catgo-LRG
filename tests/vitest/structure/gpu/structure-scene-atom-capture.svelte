<script lang="ts">
  import type { ResolvedVisualState } from '$lib/structure/rendering/visual-state'
  import { record_atom_visual_snapshot } from './structure-scene-visual-capture'

  let {
    visual_state = null,
  }: {
    visual_state?: ResolvedVisualState | null
  } = $props()

  $effect(() => {
    if (visual_state !== null) record_atom_visual_snapshot(visual_state)
  })
</script>
