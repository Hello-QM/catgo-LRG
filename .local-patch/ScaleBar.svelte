<script lang="ts">
  // Scale bar that auto-sizes to a nice round Angstrom value based on the current
  // camera projection.  Rendered as an HTML overlay at the bottom-left of the canvas.
  //
  // `pixels_per_angstrom` must be recomputed by the parent whenever the camera or
  // viewport changes — this component is pure presentation.

  let {
    pixels_per_angstrom = 0,
    show = true,
  }: {
    pixels_per_angstrom?: number
    show?: boolean
  } = $props()

  // Choose a "nice" bar length (in Å) whose pixel width stays comfortable.
  const NICE = [0.2, 0.5, 1, 2, 3, 5, 10, 15, 20, 30, 50, 100, 200, 500]
  const TARGET_PX = 100
  const MIN_PX = 50
  const MAX_PX = 220

  let bar = $derived.by(() => {
    if (pixels_per_angstrom <= 0) return null

    const ideal_ang = TARGET_PX / pixels_per_angstrom
    let best_ang = NICE[0]
    let best_diff = Infinity

    for (const n of NICE) {
      const px = n * pixels_per_angstrom
      if (px < MIN_PX || px > MAX_PX) continue
      const diff = Math.abs(px - TARGET_PX)
      if (diff < best_diff) {
        best_ang = n
        best_diff = diff
      }
    }
    // If nothing fit within bounds, pick closest to ideal
    if (best_diff === Infinity) {
      for (const n of NICE) {
        if (Math.abs(n - ideal_ang) < Math.abs(best_ang - ideal_ang)) best_ang = n
      }
    }

    const px = best_ang * pixels_per_angstrom
    // Format label: drop trailing zeros
    const label = best_ang >= 1 ? `${best_ang} Å` : `${best_ang} Å`
    return { px, label }
  })
</script>

{#if show && bar}
  <div class="scale-bar">
    <div class="bar-line" style="width:{bar.px}px">
      <div class="tick left"></div>
      <div class="tick right"></div>
    </div>
    <span class="bar-label">{bar.label}</span>
  </div>
{/if}

<style>
  .scale-bar {
    position: absolute;
    bottom: 10px;
    left: 12px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    pointer-events: none;
    z-index: 5;
  }
  .bar-line {
    height: 2px;
    background: light-dark(rgba(0,0,0,0.75), rgba(255,255,255,0.8));
    position: relative;
  }
  .tick {
    position: absolute;
    width: 2px;
    height: 8px;
    background: inherit;
    top: -3px;
  }
  .tick.left { left: 0; }
  .tick.right { right: 0; }
  .bar-label {
    font-size: 11px;
    margin-top: 2px;
    color: light-dark(rgba(0,0,0,0.75), rgba(255,255,255,0.8));
    font-family: sans-serif;
    white-space: nowrap;
  }
</style>
