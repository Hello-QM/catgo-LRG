# CatGo 的 CSS 布局模式

## 分屏视图模式（Trajectory / DOS）

### 问题

需要在一个 3D 结构查看器旁边显示一个图表面板，可以左右并排，也可以上下堆叠，并且两部分都要等分填满可用空间。

### 方案：使用 `1fr 1fr` 的 CSS Grid

**根容器**（例如 `.trajectory`、`.structure`）：

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

**内容区域**（用于分屏视图的 grid 容器）：

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

**子元素**（结构查看器、图表）：

```css
/* Both children fill their grid cell */
style="height: 100%; min-height: 0"
```

### 关键规则

1. 在 grid/flex 子项上设置 **`min-height: 0`** 可以防止溢出；没有它，内容会把容器撑得比已分配空间更大。
2. 在 content-area 上设置 **`flex: 1`**，让它填满控制区之外的剩余空间。
3. 在根元素上设置 **`container-type: size`** 可以为子面板启用 `cqh`/`cqw` 单位，但也意味着该元素必须有明确尺寸，否则 intrinsic size 会是 0。
4. 图表组件不要使用固定 `height`；使用 `ResizeObserver` 或 `height: 100%` 填满 grid cell。

## Wrapper Div 模式：`display: contents`

### 问题

有时需要一个 wrapper div，例如为了 CSS grid，但在普通模式下它应当“不可见”，不应影响布局，也不应在 box model 中引入额外嵌套。

### 方案

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

**为什么使用 `display: contents`？**

- 元素本身不生成 box，子元素会像直接位于父元素中一样渲染。
- wrapper 上的 `position: relative` 会被忽略，绝对定位子元素会穿透到祖父元素。
- 对布局没有影响，效果等同于没有这个 wrapper。
- 非常适合条件式 grid 布局：只有分屏模式才真正需要 wrapper。

**注意事项：**

- 不能在该元素上使用 `overflow`、`background`、`border`，因为它没有 box。
- 可访问性：部分屏幕阅读器可能存在问题；对于结构性 wrapper 通常无关紧要。

## Structure.svelte 布局架构

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

## Trajectory.svelte 布局架构

```
.trajectory (display: flex, flex-direction: column, height: var(--traj-height, 100%))
├── .trajectory-controls (flex-shrink: 0, natural height)
└── .content-area (display: grid, flex: 1, min-height: 0)
    ├── Structure (style="height: 100%; min-height: 0")
    └── ScatterPlot/Histogram (style="height: 100%")
```
