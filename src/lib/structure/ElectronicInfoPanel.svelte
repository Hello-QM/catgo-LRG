<script lang="ts">
  // Single rendering surface for the "Electronic structure" preview block.
  // Used by import preview modals, the loaded-structure info pane, the 3D
  // StructurePreview overlay, and workflow previews — so all four read like
  // the same widget. Pass `props` (ElectronicProps) and optional labels; an
  // empty `props` collapses the panel rather than showing 8 em-dashes.

  import { buildElectronicRows, type ElectronicProps, type ElectronicLabels } from './electronic_preview'

  interface Props {
    props: ElectronicProps | null | undefined
    labels?: Partial<ElectronicLabels>
    heading?: string | null // null/empty → no heading rendered (compact mode)
    compact?: boolean // tighter rows for use inside cards or overlays
    hide_when_empty?: boolean // default true: don't render at all if all values are missing
  }

  let {
    props,
    labels = {},
    heading = `Electronic structure`,
    compact = false,
    hide_when_empty = true,
  }: Props = $props()

  // Empty means every queryable field is null/undefined; we don't bother
  // taking screen real estate to display 8 em-dashes.
  let is_empty = $derived.by(() => {
    if (!props) return true
    const keys: (keyof ElectronicProps)[] = [
      'band_gap', 'is_metal', 'efermi', 'cbm', 'vbm',
      'has_dos', 'has_bandstructure', 'magnetic_ordering',
    ]
    return keys.every((k) => props[k] === undefined || props[k] === null)
  })

  let rows = $derived(buildElectronicRows(props ?? {}, labels))
</script>

{#if !(hide_when_empty && is_empty)}
  <div class="electronic-panel" class:compact>
    {#if heading}
      <span class="sublabel">{heading}</span>
    {/if}
    {#each rows as row (row.label + row.value)}
      <div class="info-item">
        <span class="label">{row.label}</span>
        <span class="value" class:mono={row.mono}>{row.value}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .electronic-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 0;
    min-width: 0;
  }

  .sublabel {
    color: var(--text-color-muted, #999);
    font-size: 0.85rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .info-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.9rem;
    min-width: 0;
  }

  .label {
    color: var(--text-color-muted, #999);
    min-width: 90px;
    font-weight: 500;
    flex-shrink: 0;
  }

  .value {
    color: inherit;
    flex: 1;
    word-break: break-all;
    min-width: 0;
  }

  .value.mono {
    font-family: monospace;
    font-size: 0.8rem;
  }

  .electronic-panel.compact {
    gap: 2px;
    padding: 4px 0;
  }

  .electronic-panel.compact .info-item {
    font-size: 0.78rem;
  }

  .electronic-panel.compact .label {
    min-width: 72px;
    font-size: 0.75rem;
  }

  .electronic-panel.compact .sublabel {
    font-size: 0.72rem;
  }
</style>
