/// <reference types="@sveltejs/kit" />

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
}
export {}
