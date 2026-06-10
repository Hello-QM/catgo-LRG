/// <reference types="@sveltejs/kit" />

// Extend Svelte's HTML element types to include non-standard but real iOS/Safari
// attributes that are missing from the TypeScript lib (autocorrect on textarea).
declare module 'svelte/elements' {
  interface HTMLTextareaAttributes {
    // Safari/iOS non-standard attribute — suppresses inline autocorrect on textarea
    autocorrect?: 'on' | 'off' | '' | undefined | null
  }
}

declare module 'mp-*.json' {
  const content: import('$lib/structure').PymatgenStructure
  export default content
}

declare module '*-colors.yml' {
  const content: import('$lib/colors').ElementColorScheme
  export default content
}

// type mdsvex markdown files as Svelte components
declare module '*.md' {
  const component: import('svelte').Component
  export default component
}

// Vite worker imports (inline mode bundles worker + deps into a blob)
declare module '*?worker&inline' {
  const WorkerConstructor: { new (): Worker }
  export default WorkerConstructor
}

// Global type declarations for theme system
// Using 'var' to extend globalThis for runtime access
declare global {
  // eslint-disable-next-line no-var
  var CATGO_THEMES: Record<string, Record<string, string>> | undefined
  // eslint-disable-next-line no-var
  var CATGO_CSS_MAP: Record<string, string> | undefined
  // Build-time flag injected by vite `define` in the VS Code webview build
  // (extensions/vscode/vite.config.mjs). Declared globally so .svelte
  // <script> blocks can reference it without an illegal in-component
  // `declare const` (svelte-check: "Modifiers cannot appear here").
  // eslint-disable-next-line no-var
  var __CATGO_VSCODE_EXTENSION__: boolean | undefined
}
export {}
