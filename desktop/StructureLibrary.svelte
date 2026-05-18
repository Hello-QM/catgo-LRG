<script lang="ts">
  import type { LibraryEntry } from './pane-utils'

  let {
    entries,
    active_id,
    on_select,
    on_remove,
    on_clear,
  }: {
    entries: LibraryEntry[]
    active_id: string | null
    on_select: (id: string) => void
    on_remove: (id: string) => void
    on_clear: () => void
  } = $props()

  const FORMAT_COLORS: Record<string, string> = {
    cif: `rgba(100, 149, 237, 0.9)`,
    xyz: `rgba(50, 205, 50, 0.9)`,
    extxyz: `rgba(50, 205, 50, 0.9)`,
    poscar: `rgba(255, 140, 0, 0.9)`,
    vasp: `rgba(255, 140, 0, 0.9)`,
    json: `rgba(138, 43, 226, 0.9)`,
    traj: `rgba(255, 105, 180, 0.9)`,
    h5: `rgba(255, 69, 0, 0.9)`,
    hdf5: `rgba(255, 69, 0, 0.9)`,
    cube: `rgba(0, 206, 209, 0.9)`,
    xml: `rgba(176, 124, 60, 0.9)`,
    data: `rgba(120, 144, 156, 0.9)`,
  }
  const dot_color = (fmt: string) => FORMAT_COLORS[fmt?.toLowerCase()] ?? `rgba(150, 150, 150, 0.9)`
</script>

<div class="structure-library">
  <div class="lib-header">
    <span class="lib-count">{entries.length} file{entries.length === 1 ? `` : `s`}</span>
    <button
      class="lib-clear"
      title="Clear list (keeps the open structure)"
      onclick={on_clear}
    >Clear all</button>
  </div>
  <div class="lib-list">
    {#each entries as entry (entry.id)}
      <div
        class="lib-item"
        class:active={entry.id === active_id}
        role="button"
        tabindex="0"
        title={entry.source_path || entry.filename}
        onclick={() => on_select(entry.id)}
        onkeydown={(e) => (e.key === `Enter` || e.key === ` `) && (e.preventDefault(), on_select(entry.id))}
      >
        <span class="lib-dot" style:background-color={dot_color(entry.format)}></span>
        <span class="lib-name">{entry.filename}</span>
        {#if entry.is_trajectory}<span class="lib-tag">traj</span>{/if}
        <button
          class="lib-remove"
          title="Remove from list"
          onclick={(e) => { e.stopPropagation(); on_remove(entry.id) }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    {/each}
  </div>
</div>

<style>
  .structure-library {
    width: 210px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.14));
    background: light-dark(rgba(0, 0, 0, 0.02), rgba(255, 255, 255, 0.03));
    overflow: hidden;
  }
  .lib-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.12));
    font-size: 0.7em;
  }
  .lib-count {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
  .lib-clear {
    background: transparent;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.18), rgba(255, 255, 255, 0.24));
    border-radius: 4px;
    color: var(--text-color-muted, #6b7280);
    font-size: 0.95em;
    padding: 2px 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .lib-clear:hover {
    color: var(--text-color, inherit);
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1));
  }
  .lib-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .lib-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 6px;
    border: 1px solid transparent;
    border-radius: 5px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .lib-item:hover {
    border-color: var(--accent-color, #007acc);
    background: rgba(0, 122, 204, 0.14);
  }
  .lib-item.active {
    border-color: var(--success-color, #00c853);
    background: rgba(0, 200, 83, 0.16);
    box-shadow: 0 0 6px rgba(0, 200, 83, 0.25);
  }
  .lib-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .lib-name {
    flex: 1;
    font-size: 0.72em;
    line-height: 1.15;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lib-tag {
    font-size: 0.58em;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.6;
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 0 3px;
    flex-shrink: 0;
  }
  .lib-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    opacity: 0;
    flex-shrink: 0;
    transition: opacity 0.15s ease, background 0.15s ease;
  }
  .lib-item:hover .lib-remove {
    opacity: 0.7;
  }
  .lib-remove:hover {
    opacity: 1;
    background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15));
  }
</style>
