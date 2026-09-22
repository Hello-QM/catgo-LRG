<script lang="ts">
  import Trajectory from '$lib/trajectory/Trajectory.svelte'
  import type { TrajectoryType } from '$lib/trajectory'
  let { trajectory, scene }: { trajectory: TrajectoryType; scene: Record<string, unknown> } = $props()
</script>

<Trajectory
  {trajectory}
  structure_props={{ scene_props: scene }}
  auto_play={false}
  fullscreen_toggle={false}
  show_controls={false}
  viewer_id="scene-props-review"
/>
