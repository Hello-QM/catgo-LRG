<script lang="ts">
  import { get_toasts, dismiss_toast } from './toast-state.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')

  const toasts = $derived(get_toasts())
</script>

{#if toasts.length > 0}
  <div class="toast-stack" role="region" aria-label={t('common.notifications')} aria-live="polite">
    {#each toasts as toast (toast.id)}
      <div class="toast" class:warning={toast.variant === 'warning'} class:error={toast.variant === 'error'} class:success={toast.variant === 'success'}>
        <span class="toast-msg">{toast.message}</span>
        {#if toast.action}
          <button class="toast-action" onclick={() => { toast.action?.onclick(); dismiss_toast(toast.id) }}>
            {toast.action.label}
          </button>
        {/if}
        <button class="toast-close" aria-label={t('common.dismiss')} onclick={() => dismiss_toast(toast.id)}>×</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    z-index: 10000;
    pointer-events: none;
  }
  .toast {
    background: rgba(40, 40, 44, 0.96);
    color: #e8e8ea;
    padding: 10px 14px;
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(8px);
    max-width: 600px;
    pointer-events: auto;
    font-size: 13.5px;
    animation: toast-enter 180ms ease-out;
  }
  .toast.success { border-left: 3px solid #4ade80; }
  .toast.warning { border-left: 3px solid #fbbf24; }
  .toast.error   { border-left: 3px solid #f87171; }
  .toast-msg { flex: 1; min-width: 0; }
  .toast-action {
    background: #4ade80;
    color: #1a1a1a;
    border: none;
    padding: 5px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-weight: 500;
    font-size: 13px;
    white-space: nowrap;
  }
  .toast-action:hover { background: #5fe991; }
  .toast-close {
    background: transparent;
    color: #888;
    border: none;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0 4px;
    margin-left: -4px;
  }
  .toast-close:hover { color: #e8e8ea; }
  @keyframes toast-enter {
    from { transform: translateY(8px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
</style>
