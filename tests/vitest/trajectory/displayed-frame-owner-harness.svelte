<script lang="ts">
  import Trajectory from '$lib/trajectory/Trajectory.svelte'
  import type { TrajectoryType } from '$lib/trajectory'

  let { trajectory }: { trajectory: TrajectoryType } = $props()
  // svelte-ignore state_referenced_locally -- deliberately mirrors callers
  // that adopt a generated plain trajectory into a raw bindable once.
  let active_trajectory = $state.raw<TrajectoryType | undefined>(trajectory)
</script>

<Trajectory
  bind:trajectory={active_trajectory}
  auto_play={false}
  fullscreen_toggle={false}
  show_controls={false}
  viewer_id="displayed-frame-owner-test"
/>
