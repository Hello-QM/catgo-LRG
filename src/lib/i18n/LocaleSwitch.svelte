<script lang="ts">
  /**
   * Language switcher control — cycles through System → English → 中文.
   *
   * Styled to match ThemeControl (compact select in the TabBar area).
   */
  import type { HTMLAttributes } from 'svelte/elements'
  import { get_preference, set_locale } from './index.svelte'
  import type { LocalePreference } from './types'

  let {
    onchange,
    ...rest
  }: Omit<HTMLAttributes<HTMLSelectElement>, `onchange`> & {
    onchange?: (pref: LocalePreference) => void
  } = $props()

  let current = $state<LocalePreference>(get_preference())

  const options: { value: LocalePreference; label: string; icon: string }[] = [
    { value: `system`, label: `System`,  icon: `🌐` },
    { value: `en`,     label: `English`, icon: `🇺🇸` },
    { value: `zh`,     label: `中文`,    icon: `🇨🇳` },
  ]

  async function handle_change(event: Event) {
    const pref = (event.currentTarget as HTMLSelectElement).value as LocalePreference
    current = pref
    await set_locale(pref)
    onchange?.(pref)
  }
</script>

<select
  bind:value={current}
  onchange={handle_change}
  {...rest}
  class="locale-control {rest.class ?? ``}"
>
  {#each options as { value, label, icon } (value)}
    <option {value}>{icon}&ensp;{label}</option>
  {/each}
</select>

<style>
  .locale-control {
    background: var(--btn-bg);
    border: var(--pane-border, 1px solid rgba(128, 128, 128, 0.2));
    color: var(--text-color);
    color-scheme: light !important;
    border-radius: 5pt;
    padding: 1pt 2pt;
    font-size: 11px;
    transition: all 0.2s ease;
    cursor: pointer;
  }
  .locale-control:hover {
    background: var(--btn-bg-hover);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  }
  .locale-control:focus {
    outline: 0.5px solid var(--accent-color);
  }
  :global(:root[data-theme='dark']) .locale-control,
  :global(:root[data-theme='black']) .locale-control {
    color-scheme: dark !important;
  }
  .locale-control option {
    background: #ffffff;
    color: #1f2937;
  }
  :global(:root[data-theme='dark']) .locale-control option,
  :global(:root[data-theme='black']) .locale-control option {
    background: #1f1f1f;
    color: #f5f5f5;
  }
</style>
