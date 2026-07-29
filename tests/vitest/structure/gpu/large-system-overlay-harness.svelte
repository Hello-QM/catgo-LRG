<script lang="ts">
  import LargeSystemOverlay from '$lib/structure/gpu/LargeSystemOverlay.svelte'
  import type { VisualStateSource } from '$lib/structure/rendering/visual-state'

  let visual_state_source = $state<VisualStateSource | null>(null)

  export function publish_visual_source(next: VisualStateSource | null): void {
    visual_state_source = next
  }
</script>

<LargeSystemOverlay enabled visual_state_source={visual_state_source} />
