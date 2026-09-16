<script lang="ts">
  let { scene_props = $bindable<Record<string, unknown> | undefined>(undefined) } = $props()
</script>

<div data-testid="scene-props-probe" data-scene={JSON.stringify(scene_props ?? null)}></div>
