<script lang="ts">
  import { Icon } from '$lib'
  import type { PymatgenStructure } from './index'
  import { parse_structure_file } from './parse'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  interface Props {
    visible: boolean
    onclose: () => void
    onimport: (structure: PymatgenStructure, filename: string) => void
  }
  let { visible, onclose, onimport }: Props = $props()

  // State
  let content = $state(``)
  let filename = $state(`POSCAR`)
  let error_message = $state<string | null>(null)
  let modal_element = $state<HTMLDivElement | null>(null)

  // Format options for quick selection
  const format_presets = [
    { label: `POSCAR/CONTCAR`, filename: `POSCAR` },
    { label: `CIF`, filename: `structure.cif` },
    { label: `XYZ`, filename: `structure.xyz` },
    { label: `Extended XYZ`, filename: `structure.extxyz` },
  ]

  function handle_import() {
    if (!content.trim()) {
      error_message = t('structure.paste_file_content')
      return
    }

    error_message = null

    try {
      const parsed = parse_structure_file(content, filename)
      if (parsed) {
        onimport(parsed as PymatgenStructure, filename)
        // Reset state
        content = ``
        error_message = null
        onclose()
      } else {
        error_message = t('structure.failed_parse')
      }
    } catch (err) {
      console.error(`Failed to parse pasted content:`, err)
      error_message = `${t('structure.parse_error')} ${err instanceof Error ? err.message : String(err)}`
    }
  }

  function handle_keydown(event: KeyboardEvent) {
    if (visible && event.key === `Escape`) onclose()
    // Ctrl/Cmd+Enter to import
    if (visible && event.key === `Enter` && (event.ctrlKey || event.metaKey)) {
      handle_import()
    }
  }

  function handle_click_outside(event: MouseEvent) {
    if (!modal_element) return
    const target = event.target as HTMLElement
    if (!modal_element.contains(target)) onclose()
  }

  // Reset error when content changes
  $effect(() => {
    if (content) error_message = null
  })
</script>

<svelte:window onkeydown={handle_keydown} />

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={handle_click_outside}>
    <div class="modal-content" bind:this={modal_element} role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>{t('structure.paste_structure_content')}</h2>
        <button class="close-btn" onclick={onclose} aria-label={t('common.close')}>×</button>
      </div>

      <div class="modal-body">
        <!-- Format selection -->
        <div class="format-section">
          <label for="format-select">{t('structure.format')}</label>
          <div class="format-presets">
            {#each format_presets as preset (preset.filename)}
              <button
                type="button"
                class="format-preset-btn"
                class:active={filename === preset.filename}
                onclick={() => (filename = preset.filename)}
              >
                {preset.label}
              </button>
            {/each}
          </div>
          <div class="filename-input">
            <label for="filename-input">{t('structure.custom_filename')}</label>
            <input
              id="filename-input"
              type="text"
              placeholder="e.g., POSCAR, structure.cif"
              bind:value={filename}
            />
          </div>
        </div>

        <!-- Content textarea -->
        <div class="content-section">
          <label for="content-input">{t('structure.paste_content_desc')}</label>
          <textarea
            id="content-input"
            bind:value={content}
            placeholder={`Example POSCAR format:
Si2
1.0
3.867 0.000 0.000
0.000 3.867 0.000
0.000 0.000 3.867
Si
2
Direct
0.000 0.000 0.000
0.500 0.500 0.500`}
            spellcheck="false"
          ></textarea>
          <div class="content-hint">
            <Icon icon="Info" />
            <span>{t('structure.paste_hint')}</span>
          </div>
        </div>

        {#if error_message}
          <div class="error-message">
            <Icon icon="Alert" />
            <span>{error_message}</span>
          </div>
        {/if}

        <!-- Action buttons -->
        <div class="action-buttons">
          <button type="button" class="cancel-btn" onclick={onclose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            class="import-btn"
            onclick={handle_import}
            disabled={!content.trim()}
          >
            <Icon icon="Download" /> {t('structure.import_structure')}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100000010;
    padding: 16px;
    overflow: auto;
    box-sizing: border-box;
  }
  .modal-content {
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: 8px;
    width: min(700px, calc(100vw - 32px));
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    box-sizing: border-box;
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, #444);
    min-width: 0;
  }
  .modal-header h2 {
    margin: 0;
    font-size: 1.1rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: inherit;
    font-size: 20px;
    cursor: pointer;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .close-btn:hover {
    background: var(--surface-bg-hover, #333);
  }
  .modal-body {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    min-width: 0;
  }
  .format-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .format-section > label {
    font-size: 0.9rem;
    font-weight: 500;
  }
  .format-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .format-preset-btn {
    padding: 6px 12px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.85rem;
    transition: all 0.15s ease;
  }
  .format-preset-btn:hover {
    background: var(--surface-bg-hover, #333);
  }
  .format-preset-btn.active {
    background: var(--accent-color, #0066cc);
    border-color: var(--accent-color, #0066cc);
  }
  .filename-input {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    min-width: 0;
  }
  .filename-input label {
    font-size: 0.85rem;
    color: var(--text-color-muted, #999);
    white-space: nowrap;
  }
  .filename-input input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--surface-bg, #1e1e1e);
    color: inherit;
    font-size: 0.85rem;
    max-width: 200px;
    min-width: 0;
  }
  .content-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .content-section > label {
    font-size: 0.9rem;
    font-weight: 500;
  }
  .content-section textarea {
    flex: 1;
    min-height: 250px;
    padding: 12px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: var(--surface-bg, #1e1e1e);
    color: inherit;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
    font-size: 0.85rem;
    line-height: 1.4;
    resize: vertical;
    min-width: 0;
    box-sizing: border-box;
  }
  .content-section textarea::placeholder {
    color: var(--text-color-muted, #666);
  }
  .content-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: var(--text-color-muted, #999);
  }
  .error-message {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.3);
    border-radius: 4px;
    color: #ff6b6b;
    font-size: 0.9rem;
  }
  .action-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding-top: 8px;
    border-top: 1px solid var(--border-color, #444);
    flex-wrap: wrap;
  }
  .cancel-btn {
    padding: 8px 16px;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .cancel-btn:hover {
    background: var(--surface-bg-hover, #333);
  }
  .import-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    background: var(--accent-color, #0066cc);
    color: white;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .import-btn:hover:not(:disabled) {
    opacity: 0.9;
  }
  .import-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 520px) {
    .modal-overlay {
      padding: 8px;
    }

    .modal-content {
      width: calc(100vw - 16px);
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
    }

    .filename-input {
      flex-direction: column;
      align-items: stretch;
    }

    .filename-input input {
      max-width: none;
    }
  }
</style>
