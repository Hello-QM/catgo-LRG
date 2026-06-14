# Plotly.js 图表配置参考

## 图例

### 内置交互

- **单击**图例项：切换 trace 可见性（默认行为）
- **双击**图例项：只显示该 trace，隐藏其他 trace
- 通过 `layout.legend.itemclick` 控制：`"toggle"` | `"toggleothers"` | `false`
- 通过 `layout.legend.itemdoubleclick` 控制，取值相同

### 可拖拽图例

在 **config** 中设置，而不是 layout：

```js
config: {
  edits: {
    legendPosition: true,  // allow user to drag legend
    // Other granular edits:
    // legendText: true,       // edit legend text
    // axisTitleText: true,    // edit axis titles
    // titleText: true,        // edit chart title
    // annotationPosition: true,
  }
}
```

### 图例位置（layout）

```js
layout: {
  showlegend: true,
  legend: {
    x: 1.02,           // 0=left, 1=right edge of plot
    y: 1,              // 0=bottom, 1=top
    xanchor: "left",   // "auto" | "left" | "center" | "right"
    yanchor: "top",    // "auto" | "top" | "middle" | "bottom"
    orientation: "v",  // "v" (vertical) | "h" (horizontal)
    bgcolor: "rgba(0,0,0,0.3)",
    bordercolor: "#ccc",
    borderwidth: 1,
    font: { color: "#ccc", size: 10 },
  }
}
```

### 从图中隐藏特定 Trace，但保留在图例中

```js
trace.visible = "legendonly"  // hidden but appears in legend for toggling
trace.visible = true          // visible
trace.visible = false         // completely hidden (no legend entry)
trace.showlegend = false      // visible trace but no legend entry
```

## 网格线

```js
xaxis: {
  showgrid: true,               // show/hide gridlines
  gridcolor: "rgba(255,255,255,0.1)",
  gridwidth: 1,                 // px
  griddash: "solid",            // "solid" | "dot" | "dash" | "longdash" | "dashdot"
  zeroline: true,               // distinct line at zero
  zerolinewidth: 1,
  zerolinecolor: "#444",
}
```

## 坐标轴线

```js
xaxis: {
  showline: true,               // show axis line
  linecolor: "rgba(200,200,200,0.5)",
  linewidth: 1,                 // px
  mirror: true,                 // true | "ticks" | false | "all" | "allticks"
  // mirror=true: line on opposite side too
  // mirror="ticks": line + ticks on opposite side
}
```

## 刻度

```js
xaxis: {
  ticks: "outside",             // "outside" | "inside" | "" (none)
  ticklen: 5,                   // length in px
  tickwidth: 1,                 // width in px
  tickcolor: "rgba(200,200,200,0.5)",
  tickangle: 0,                 // rotation angle for labels (-45 for diagonal)
  showticklabels: true,
  tickfont: { family: "monospace", size: 11, color: "#ccc" },
  // Custom tick placement:
  tickmode: "auto",             // "auto" | "linear" | "array"
  nticks: 10,                   // max ticks (auto mode)
  dtick: 1,                     // spacing (linear mode)
  tickvals: [0, 1, 2],          // positions (array mode)
  ticktext: ["a", "b", "c"],    // labels (array mode)
}
```

## 深色主题模板

```js
layout: {
  plot_bgcolor: "rgba(0,0,0,0)",
  paper_bgcolor: "rgba(0,0,0,0)",
  font: { color: "#ccc", size: 11 },
  xaxis: {
    gridcolor: "rgba(255,255,255,0.1)",
    linecolor: "rgba(200,200,200,0.5)",
    tickcolor: "rgba(200,200,200,0.5)",
    zerolinecolor: "rgba(255,255,255,0.15)",
  },
  yaxis: { /* same as xaxis */ },
}
```

## Plotly Config 对象

```js
const config = {
  responsive: true,              // auto-resize with container
  displayModeBar: true,          // show toolbar
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
  toImageButtonOptions: {
    format: "svg",               // "png" | "svg" | "jpeg" | "webp"
    filename: "my_plot",
    width: 800,
    height: 600,
    scale: 2,                    // resolution multiplier
  },
  edits: {
    legendPosition: true,
  },
}
```

## 动态导入（SSR 安全，Svelte）

```ts
$effect(() => {
  if (typeof window !== "undefined" && !Plotly) {
    import("plotly.js-dist-min").then((mod) => {
      Plotly = mod.default ?? mod
    })
  }
})
```

## 使用 ResizeObserver 响应式设置高度

```ts
let container_div: HTMLDivElement | undefined = $state()
let container_height: number = $state(400)

$effect(() => {
  if (!container_div) return
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const h = entry.contentRect.height
      if (h > 50) container_height = h
    }
  })
  ro.observe(container_div)
  return () => ro.disconnect()
})

// Then use container_height in layout.height
```

## 色板（Plotly 默认 D3 category10）

```js
const COLORS = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
]
```
