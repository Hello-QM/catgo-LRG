<script lang="ts">
  import type { AnyStructure } from '$lib'

  let {
    structure = $bindable<AnyStructure | undefined>(undefined),
    bridge_structure = undefined,
    trajectory_frame_positions = null,
  }: {
    structure?: AnyStructure
    bridge_structure?: AnyStructure
    trajectory_frame_positions?: Float32Array | null
  } = $props()
</script>

<div
  data-testid="displayed-frame-owner-probe"
  data-structure-sites={structure?.sites.length ?? 0}
  data-bridge-sites={bridge_structure?.sites.length ?? 0}
  data-position-count={trajectory_frame_positions?.length ?? 0}
></div>
