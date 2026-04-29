<script lang="ts">
  import type { Vec3 } from '$lib/math'
    import { HTML } from '@threlte/extras'
    import type { Snippet } from 'svelte'
    import type { HTMLAttributes } from 'svelte/elements'

    let { position, children, ...rest }: HTMLAttributes<HTMLDivElement> & {
      position: Vec3
      children: Snippet<[]>
    } = $props()

    // Ensure position is a valid Vec3 to prevent Threlte HTML errors
    let valid_position = $derived(
      Array.isArray(position) && position.length === 3 &&
      position.every(v => typeof v === 'number' && !Number.isNaN(v))
        ? position
        : null
    )
</script>

{#if valid_position}
  {#key valid_position.join(`,`)}
    <HTML position={valid_position} pointerEvents="none">
      <div {...rest} class="tooltip {rest.class ?? ``}" role="tooltip">
        {@render children()}
      </div>
    </HTML>
  {/key}
{/if}

<style>
  .tooltip {
    width: max-content;
    box-sizing: border-box;
    text-align: var(--canvas-tooltip-text-align, left);
    border-radius: var(--canvas-tooltip-border-radius, 5pt);
    background: var(--canvas-tooltip-bg, var(--code-bg));
    padding: var(--canvas-tooltip-padding, 1pt 5pt);
    color: var(--canvas-tooltip-text-color);
    font-family: var(--canvas-tooltip-font-family);
    font-size: var(--canvas-tooltip-font-size, clamp(8pt, 3cqmin, 18pt));
    line-height: var(--canvas-tooltip-line-height);
    pointer-events: none;
  }
</style>
