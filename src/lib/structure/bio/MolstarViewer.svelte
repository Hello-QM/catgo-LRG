<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  let {
    content,
    format = `pdb`,
    label = `structure`,
  }: { content: string; format?: string; label?: string } = $props()

  let container = $state<HTMLDivElement>()
  // Inferred from molstar's own d.ts (it ships resolvable types). Awaited
  // return of Viewer.create — keeps `format` as molstar's BuiltInTrajectoryFormat
  // literal union so loadStructureFromData type-checks.
  type Mol = Awaited<
    ReturnType<typeof import('molstar/lib/apps/viewer/app').Viewer.create>
  >
  let viewer: Mol | null = null
  let error = $state<string | null>(null)

  onMount(async () => {
    try {
      // Prebuilt CSS skin (plain CSS — no sass toolchain needed).
      await import(`molstar/build/viewer/molstar.css`)
      const { Viewer } = await import(`molstar/lib/apps/viewer/app`)
      if (!container) return
      const v = await Viewer.create(container, {
        layoutIsExpanded: false,
        layoutShowControls: true,
        layoutShowSequence: true,
        layoutShowLog: false,
        layoutShowLeftPanel: true,
        viewportShowExpand: true,
        viewportShowSelectionMode: true,
      })
      viewer = v
      await v.loadStructureFromData(content, format as never, {
        dataLabel: label,
      })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      console.error(`[MolstarViewer] failed to load:`, e)
    }
  })

  onDestroy(() => {
    viewer?.dispose()
    viewer = null
  })
</script>

<div class="molstar-pane" bind:this={container}>
  {#if error}
    <div class="molstar-error">Mol* failed to load: {error}</div>
  {/if}
</div>

<style>
  /* Mol*'s UI positions absolutely inside this box; it needs relative + size.
     Never display:none this pane on mobile — it zeroes the WebGL canvas
     (see CLAUDE.md iOS invariants). */
  .molstar-pane {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .molstar-error {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 1rem;
    color: var(--error-color, #c0392b);
    font-size: 0.9rem;
    text-align: center;
  }
</style>
