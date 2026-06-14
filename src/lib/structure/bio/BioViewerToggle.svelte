<script lang="ts">
  import { t } from '$lib/i18n/index.svelte'

  let {
    is_molstar,
    on_toggle,
  }: { is_molstar: boolean; on_toggle: () => void } = $props()
</script>

<button class="bio-toggle" onclick={on_toggle} type="button">
  {is_molstar ? t(`structure.bio_open_in_native`) : t(`structure.bio_open_in_molstar`)}
</button>

<style>
  .bio-toggle {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 20;
    padding: 4px 10px;
    font-size: 0.78rem;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 6px;
    background: var(--panel-bg, rgba(255, 255, 255, 0.9));
    color: var(--text-color, #222);
    cursor: pointer;
  }
  .bio-toggle:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.06));
  }
</style>
