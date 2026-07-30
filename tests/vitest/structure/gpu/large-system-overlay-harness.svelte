<script lang="ts">
  import LargeSystemOverlay from '$lib/structure/gpu/LargeSystemOverlay.svelte'
  import type { VisualStateSource } from '$lib/structure/rendering/visual-state'
  import type { HudSafeArea } from '$lib/structure/rendering/gizmo'

  let visual_state_source = $state<VisualStateSource | null>(null)
  let hud_safe = $state<HudSafeArea>({ l: 0, r: 0, t: 0, b: 0 })

  export function publish_visual_source(next: VisualStateSource | null): void {
    visual_state_source = next
  }

  export function publish_hud_safe(next: HudSafeArea): void {
    hud_safe = next
  }
</script>

<LargeSystemOverlay enabled visual_state_source={visual_state_source} {hud_safe} />
