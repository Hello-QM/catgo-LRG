<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements'

  let {
    message = $bindable(),
    type = `info`,
    dismissible = false,
    ...rest
  }: HTMLAttributes<HTMLDivElement> & {
    message?: string
    type?: `info` | `error` | `warning`
    dismissible?: boolean
  } = $props()

  const styles = {
    info: {
      background: `transparent`,
      color: `var(--text-color-dim, #666)`,
      border: `2px dashed var(--border-color, #ccc)`,
      padding: `2em`,
      textAlign: `center` as const,
    },
    error: {
      background: `light-dark(#ffebee, rgba(239, 68, 68, 0.1))`,
      color: `var(--error-color, #c62828)`,
      border: `1px solid var(--error-color, #ef5350)`,
      padding: `0.5em`,
      textAlign: `left` as const,
    },
    warning: {
      background: `light-dark(#fff3e0, rgba(251, 191, 36, 0.1))`,
      color: `var(--warning-color, #e65100)`,
      border: `1px solid var(--warning-color, #fb8c00)`,
      padding: `0.5em`,
      textAlign: `left` as const,
    },
  }
</script>

{#if message}
  <div
    class="message"
    role={type === `error` ? `alert` : `status`}
    aria-live={type === `error` ? `assertive` : `polite`}
    style:background={styles[type].background}
    style:color={styles[type].color}
    style:border={styles[type].border}
    style:padding={styles[type].padding}
    style:text-align={styles[type].textAlign}
    {...rest}
  >
    {message}
    {#if dismissible}
      <button
        type="button"
        aria-label="Dismiss message"
        onclick={() => (message = undefined)}
      >
        Dismiss
      </button>
    {/if}
  </div>
{/if}

<style>
  .message {
    margin-bottom: 0.5em;
    border-radius: var(--radius-sm);
  }
  button {
    margin-left: 1em;
    padding: 0.25em 0.75em;
    background: var(--surface-bg, light-dark(#e0e0e0, rgba(255, 255, 255, 0.1)));
    border: 1px solid var(--border-color, #ccc);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  button:hover {
    background: light-dark(#d0d0d0, rgba(255, 255, 255, 0.15));
  }
</style>
