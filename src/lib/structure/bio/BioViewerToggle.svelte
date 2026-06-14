<script lang="ts">
  import { t } from '$lib/i18n/index.svelte'

  let {
    is_molstar,
    on_toggle,
  }: { is_molstar: boolean; on_toggle: () => void } = $props()
</script>

<button class="bio-toggle" class:to-molstar={!is_molstar} onclick={on_toggle} type="button">
  <span class="bio-toggle-icon">{is_molstar ? `←` : `🧬`}</span>
  {is_molstar ? t(`structure.bio_open_in_native`) : t(`structure.bio_open_in_molstar`)}
</button>

<style>
  /* Unpositioned by design — the parent (Mol* toolbar or native float wrapper)
     decides placement, so the button never collides with Mol*'s own UI. */
  .bio-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    font-size: 0.78rem;
    line-height: 1.2;
    white-space: nowrap;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 6px;
    background: var(--panel-bg, rgba(255, 255, 255, 0.92));
    color: var(--text-color, #222);
    cursor: pointer;
  }
  /* "Open in Mol*" gets an accent so it's easy to find on a busy native viewer. */
  .bio-toggle.to-molstar {
    border-color: var(--accent-color, #2e8b6f);
    color: var(--accent-color, #2e8b6f);
    background: var(--panel-bg, rgba(255, 255, 255, 0.92));
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }
  .bio-toggle:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
  }
  .bio-toggle-icon {
    font-size: 0.85rem;
  }
</style>
