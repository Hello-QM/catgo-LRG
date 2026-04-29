# CSS Layout Patterns for CatGo

## Split-View Pattern (Trajectory / DOS)

### Problem
Need to show a 3D structure viewer alongside a plot panel (side-by-side or stacked),
where both halves fill their space equally.

### Solution: CSS Grid with `1fr 1fr`

**Root container** (e.g. `.trajectory`, `.structure`):
```css
.container {
  display: flex;         /* or grid */
  flex-direction: column;
  height: var(--height, 100%);
  container-type: size;  /* enable cqh/cqw for child panes */
  position: relative;
  overflow: hidden;
}
```

**Content area** (grid container for split view):
```css
.content-area {
  display: grid;
  flex: 1;               /* fills remaining space after controls */
  min-height: 0;         /* CRITICAL: allows grid to shrink */
}
.horizontal .content-area {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr;
}
.vertical .content-area {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr 1fr;
}
```

**Children** (structure viewer, plot):
```css
/* Both children fill their grid cell */
style="height: 100%; min-height: 0"
```

### Key Rules
1. **`min-height: 0`** on grid/flex items prevents overflow — without it, content pushes the container larger than its allocation
2. **`flex: 1`** on content-area makes it expand to fill available space
3. **`container-type: size`** on root enables `cqh`/`cqw` units for panes but also means the element MUST have explicit sizing (intrinsic size = 0)
4. **No fixed `height` on plot components** — use `ResizeObserver` or `height: 100%` to fill the grid cell

## Wrapper Div Pattern: `display: contents`

### Problem
Sometimes you need a wrapper div (e.g. for CSS grid) that should be "invisible" in normal mode — it shouldn't affect layout or introduce extra nesting in the box model.

### Solution
```css
/* Default: invisible wrapper */
.wrapper {
  display: contents;
}
/* When split-view is active, becomes a real grid item */
.container.split > .wrapper {
  display: block;
  position: relative;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}
```

**Why `display: contents`?**
- Element doesn't generate a box → children render as if directly inside the parent
- `position: relative` on the wrapper is ignored → absolutely positioned children fall through to the grandparent
- Zero layout impact — identical to having no wrapper at all
- Perfect for conditional grid layouts where the wrapper is only needed in split mode

**Caveats:**
- No `overflow`, `background`, `border` on the element (it has no box)
- Accessibility: some screen readers may have issues (not relevant for structural wrappers)

## Structure.svelte Layout Architecture

```
.structure (position: relative, container-type: size, height from CSS var)
├── Normal mode: display: block
│   └── .structure-main (display: contents → invisible)
│       ├── Canvas wrapper (height: 100%)
│       ├── Control panes (position: absolute)
│       └── Modals, overlays, etc.
│
├── DOS split mode: display: grid
│   ├── .structure-main (display: block, grid item)
│   │   └── [same children as normal mode]
│   └── .dos-panel (flex column, grid item)
│       ├── .dos-panel-header (flex-shrink: 0)
│       └── .dos-plot-area (flex: 1, min-height: 0)
│           └── DosPlot (height: 100%, ResizeObserver)
```

## Trajectory.svelte Layout Architecture

```
.trajectory (display: flex, flex-direction: column, height: var(--traj-height, 100%))
├── .trajectory-controls (flex-shrink: 0, natural height)
└── .content-area (display: grid, flex: 1, min-height: 0)
    ├── Structure (style="height: 100%; min-height: 0")
    └── ScatterPlot/Histogram (style="height: 100%")
```
