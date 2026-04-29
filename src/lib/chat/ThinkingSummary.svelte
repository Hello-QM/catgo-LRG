<!-- src/lib/chat/ThinkingSummary.svelte
     Compact, Claude-style "thinking" indicator that wraps CatBot's active tool
     calls. Default view is a single animated line ("Thinking… · N tools"),
     which the user can expand into the full ToolProgressBlock list on click.

     Usage:
       <ThinkingSummary tools={active_tool_blocks.entries}>
         {#each Object.entries(active_tool_blocks.entries) as [id, tb] (id)}
           <ToolProgressBlock ... />
         {/each}
       </ThinkingSummary>
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  interface ToolEntry {
    toolName: string
    input: unknown
    output: string
    status: string
    elapsedSeconds: number
  }

  interface Props {
    tools: Record<string, ToolEntry>
    children?: Snippet
  }

  let { tools, children }: Props = $props()

  let expanded = $state(false)

  const ids = $derived(Object.keys(tools))
  const total_count = $derived(ids.length)
  const running_count = $derived(ids.filter((id) => tools[id]?.status === `running`).length)
  const all_done = $derived(total_count > 0 && running_count === 0)

  const label = $derived.by(() => {
    if (total_count === 0) return ``
    if (running_count > 0) {
      return total_count === 1 ? `Thinking…` : `Thinking… · ${total_count} tool${total_count === 1 ? `` : `s`}`
    }
    return `Used ${total_count} tool${total_count === 1 ? `` : `s`}`
  })
</script>

{#if total_count > 0}
  <div class="thinking-summary" class:is-thinking={running_count > 0} class:is-done={all_done}>
    <button class="summary-header" type="button" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
      <span class="pulse" aria-hidden="true">
        {#if running_count > 0}
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        {:else}
          <span class="check">✓</span>
        {/if}
      </span>
      <span class="label">{label}</span>
      <span class="chevron" class:open={expanded} aria-hidden="true">▸</span>
    </button>
    {#if expanded}
      <div class="tools-detail">
        {@render children?.()}
      </div>
    {/if}
  </div>
{/if}

<style>
  .thinking-summary {
    border-left: 2px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
    margin: 0.4em 0;
    padding-left: 0.6em;
  }
  .summary-header {
    display: flex;
    align-items: center;
    gap: 0.6em;
    width: 100%;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #888);
    padding: 0.3em 0;
    font-size: 0.85em;
    text-align: left;
  }
  .summary-header:hover {
    color: var(--text, #ddd);
  }
  .summary-header:focus-visible {
    outline: 2px solid var(--accent, #6b9aff);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .pulse {
    display: inline-flex;
    gap: 3px;
    min-width: 20px;
    justify-content: center;
  }
  .pulse .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    animation: dot-pulse 1.4s infinite ease-in-out both;
  }
  .pulse .dot:nth-child(1) { animation-delay: -0.32s; }
  .pulse .dot:nth-child(2) { animation-delay: -0.16s; }
  .pulse .dot:nth-child(3) { animation-delay: 0s; }
  @keyframes dot-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.7); }
    40%           { opacity: 1;   transform: scale(1);   }
  }
  .is-thinking .summary-header {
    color: var(--accent, #6b9aff);
  }
  .check {
    color: var(--success, #4caf50);
    font-weight: bold;
  }
  .label {
    flex: 1;
  }
  .chevron {
    transition: transform 0.15s ease;
    font-size: 0.75em;
    opacity: 0.7;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .tools-detail {
    margin-top: 0.4em;
    display: flex;
    flex-direction: column;
    gap: 0.3em;
    padding-bottom: 0.3em;
  }
</style>
