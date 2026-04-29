// Custom VitePress theme — extends default with scientific styling
import DefaultTheme from "vitepress/theme"
import type { Theme } from "vitepress"
import "./custom.css"

export default {
  extends: DefaultTheme,
} satisfies Theme
