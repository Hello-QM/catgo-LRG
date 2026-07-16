<script lang="ts">
  import Trajectory from '$lib/trajectory/Trajectory.svelte'
  import type { TrajectoryType } from '$lib/trajectory'

  let { trajectory }: { trajectory: TrajectoryType } = $props()
  // svelte-ignore state_referenced_locally -- deliberately mirrors callers
  // that adopt a generated plain trajectory into a raw bindable once.
  let active_trajectory = $state.raw<TrajectoryType | undefined>(trajectory)
  let supercell_scaling = $state(`1x1x1`)

  export function swap_trajectory(next: TrajectoryType | undefined) {
    active_trajectory = next
  }
  export function get_trajectory(): TrajectoryType | undefined {
    return active_trajectory
  }
  export function set_scaling(next: string) {
    supercell_scaling = next
  }
  export function get_scaling(): string {
    return supercell_scaling
  }
</script>

<Trajectory
  bind:trajectory={active_trajectory}
  bind:supercell_scaling
  auto_play={false}
  fullscreen_toggle={false}
  show_controls={false}
  viewer_id="supercell-label-reset-test"
/>
