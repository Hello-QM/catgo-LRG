import { defineConfig } from 'vitepress'

export default defineConfig({
  title: `CatGo`,
  description:
    `AI-driven workbench for computational materials science. Build structures, run workflows on HPC, and chat with CatBot — all from one desktop app.`,
  lang: `en-US`,

  // Deploy as static site under /docs/ or root — adjust as needed
  base: `/`,

  // Clean URLs without .html extension
  cleanUrls: true,

  // Localhost links in install/dev docs are intentional, not navigable.
  ignoreDeadLinks: [/^https?:\/\/localhost(:\d+)?/],

  // Locales — English at root, 简体中文 under /zh/
  locales: {
    root: {
      label: `English`,
      lang: `en-US`,
    },
    zh: {
      label: `简体中文`,
      lang: `zh-CN`,
      link: `/zh/`,
      themeConfig: {
        nav: [
          { text: `首页`, link: `/zh/` },
          { text: `指南`, link: `/zh/guide/installation` },
          { text: `CatBot AI`, link: `/zh/guide/catbot` },
          { text: `GitHub`, link: `https://github.com/Hello-QM/catgo-LRG` },
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: `入门`,
              items: [
                { text: `安装`, link: `/zh/guide/installation` },
                { text: `CatBot AI`, link: `/zh/guide/catbot` },
              ],
            },
          ],
        },
        footer: {
          message: `基于 AGPL-3.0-or-later 许可证发布。`,
          copyright: `Copyright 2024-present CatGo Contributors`,
        },
        docFooter: { prev: `上一页`, next: `下一页` },
        outline: { level: [2, 3], label: `本页内容` },
        editLink: {
          pattern: `https://github.com/Hello-QM/catgo-LRG/edit/main/docs/:path`,
          text: `在 GitHub 上编辑此页`,
        },
        lastUpdated: { text: `最后更新于` },
        returnToTopLabel: `回到顶部`,
        sidebarMenuLabel: `菜单`,
        darkModeSwitchLabel: `主题`,
        lightModeSwitchTitle: `切换到浅色模式`,
        darkModeSwitchTitle: `切换到深色模式`,
      },
    },
  },

  // Exclude internal-only docs (specs, debug logs, dev architecture notes)
  // from the public site. Files remain in repo for contributors.
  srcExclude: [
    `archive/**`,
    `superpowers/**`,
    `DEBUG_LOG_*.md`,
    `rendering-code-review-*.md`,
    `catgo_graph_*.md`,
    `catgo_recipe_catalog.md`,
    `catgo_runtime_requirements.md`,
    `catgo_rust_runtime_architecture.md`,
    `catgo_unified_workflow_architecture.md`,
    `catgo_workflow_capabilities.md`,
    `DEVELOPMENT_GUIDE.md`,
  ],

  // Markdown options
  markdown: {
    math: true, // KaTeX for equations
    lineNumbers: true,
  },

  // <head> tags
  head: [
    [`link`, { rel: `icon`, href: `/favicon.svg`, type: `image/svg+xml` }],
    [`meta`, { name: `theme-color`, content: `#3b82f6` }],
  ],

  // Theme configuration
  themeConfig: {
    logo: {
      light: `/logo-light.svg`,
      dark: `/logo-dark.svg`,
    },

    // Top navigation bar
    nav: [
      { text: `Home`, link: `/` },
      { text: `Guide`, link: `/guide/overview` },
      { text: `Tutorials`, link: `/tutorials/basics/getting-started` },
      {
        text: `Modules`,
        items: [
          { text: `Overview`, link: `/modules/` },
          {
            text: `Core`,
            items: [
              { text: `Structure Viewer`, link: `/modules/core/structure-viewer` },
              { text: `File I/O`, link: `/modules/core/file-io` },
              { text: `Bonding`, link: `/modules/core/bonding` },
              { text: `Settings`, link: `/modules/core/settings` },
            ],
          },
          {
            text: `Analysis`,
            items: [
              {
                text: `Electronic Structure`,
                link: `/modules/electronic/band-structure`,
              },
              { text: `MD Analysis`, link: `/modules/md-analysis/rdf` },
              { text: `Spectroscopy`, link: `/modules/analysis/spectroscopy` },
            ],
          },
          {
            text: `Features`,
            items: [
              { text: `Workflow Engine`, link: `/modules/workflow/workflow-engine` },
              { text: `AI Chat`, link: `/modules/ai/chat-system` },
              { text: `Gesture Tracking`, link: `/modules/interaction/gesture-tracking` },
              { text: `MCP Server`, link: `/modules/server/mcp-server` },
            ],
          },
        ],
      },
      { text: `Developer`, link: `/developer/contributing` },
      {
        text: `More`,
        items: [
          { text: `Gallery`, link: `/guide/gallery` },
          { text: `Tips & Tricks`, link: `/guide/tips-and-tricks` },
          { text: `Configuration`, link: `/reference/configuration` },
          { text: `FAQ`, link: `/reference/faq` },
          { text: `Changelog`, link: `/reference/changelog` },
        ],
      },
    ],

    // Multi-sidebar — different sidebars for different sections
    sidebar: {
      '/guide/': [
        {
          text: `Getting Started`,
          items: [
            { text: `Overview`, link: `/guide/overview` },
            { text: `Installation`, link: `/guide/installation` },
            { text: `CatBot AI`, link: `/guide/catbot` },
            { text: `Gallery`, link: `/guide/gallery` },
            { text: `Tips & Tricks`, link: `/guide/tips-and-tricks` },
          ],
        },
      ],

      '/tutorials/': [
        {
          text: `Tutorials`,
          link: `/tutorials/`,
          items: [
            {
              text: `Basics`,
              collapsed: false,
              items: [
                { text: `Getting Started`, link: `/tutorials/basics/getting-started` },
              ],
            },
            {
              text: `Structures`,
              collapsed: false,
              items: [
                { text: `Building Slabs`, link: `/tutorials/structures/building-slabs` },
                { text: `Optimization`, link: `/tutorials/structures/optimization` },
                {
                  text: `Database Search`,
                  link: `/tutorials/structures/database-search`,
                },
              ],
            },
            {
              text: `Visualization`,
              collapsed: false,
              items: [
                {
                  text: `Density Visualization`,
                  link: `/tutorials/visualization/density-viz`,
                },
                { text: `Trajectories`, link: `/tutorials/visualization/trajectories` },
              ],
            },
            {
              text: `Workflows`,
              collapsed: false,
              items: [
                { text: `Workflows`, link: `/tutorials/workflows/workflows` },
              ],
            },
            {
              text: `Electronic Analysis`,
              collapsed: false,
              items: [
                { text: `Band Structure`, link: `/tutorials/electronic/band-structure` },
                { text: `DOS Analysis`, link: `/tutorials/electronic/dos-analysis` },
                { text: `COHP Analysis`, link: `/tutorials/electronic/cohp-analysis` },
              ],
            },
            {
              text: `MD Analysis`,
              collapsed: false,
              items: [
                { text: `RDF Analysis`, link: `/tutorials/md-analysis/rdf-analysis` },
                { text: `RMSD & RMSF`, link: `/tutorials/md-analysis/rmsd-rmsf` },
                {
                  text: `H-Bond Detection`,
                  link: `/tutorials/md-analysis/hbond-detection`,
                },
                {
                  text: `Clustering & PCA`,
                  link: `/tutorials/md-analysis/clustering-pca`,
                },
              ],
            },
            {
              text: `AI Features`,
              collapsed: false,
              items: [
                { text: `AI Chat`, link: `/tutorials/ai/ai-chat` },
                { text: `Literature Import`, link: `/tutorials/ai/literature-import` },
              ],
            },
            {
              text: `Interaction`,
              collapsed: false,
              items: [
                {
                  text: `Gesture & Hand Tracking`,
                  link: `/tutorials/interaction/gesture-hand-tracking`,
                },
                { text: `Voice Control`, link: `/tutorials/interaction/voice-control` },
              ],
            },
            {
              text: `Desktop`,
              collapsed: false,
              items: [
                { text: `Desktop App`, link: `/tutorials/desktop/desktop-app` },
              ],
            },
            {
              text: `Server`,
              collapsed: false,
              items: [
                { text: `MCP Server`, link: `/tutorials/server/mcp-server` },
                { text: `Server API`, link: `/tutorials/server/server-api` },
              ],
            },
          ],
        },
      ],

      '/modules/': [
        {
          text: `Module Reference`,
          link: `/modules/`,
          items: [
            {
              text: `Core`,
              collapsed: false,
              items: [
                { text: `Structure Viewer`, link: `/modules/core/structure-viewer` },
                { text: `File I/O`, link: `/modules/core/file-io` },
                { text: `Lattice & Cell`, link: `/modules/core/lattice-cell` },
                { text: `Bonding`, link: `/modules/core/bonding` },
                { text: `Settings`, link: `/modules/core/settings` },
              ],
            },
            {
              text: `Crystallography`,
              collapsed: false,
              items: [
                {
                  text: `Surfaces & Slabs`,
                  link: `/modules/crystallography/surfaces-slabs`,
                },
                { text: `Symmetry`, link: `/modules/crystallography/symmetry` },
                { text: `Supercells`, link: `/modules/crystallography/supercells` },
              ],
            },
            {
              text: `Electronic Structure`,
              collapsed: false,
              items: [
                { text: `Band Structure`, link: `/modules/electronic/band-structure` },
                { text: `Density of States`, link: `/modules/electronic/dos` },
                { text: `COHP`, link: `/modules/electronic/cohp` },
              ],
            },
            {
              text: `MD Analysis`,
              collapsed: false,
              items: [
                { text: `Radial Distribution`, link: `/modules/md-analysis/rdf` },
                { text: `Dynamics (RMSD/RMSF)`, link: `/modules/md-analysis/dynamics` },
                { text: `Density Profile`, link: `/modules/md-analysis/density-profile` },
                { text: `Hydrogen Bonds`, link: `/modules/md-analysis/hbonds` },
                { text: `Clustering & PCA`, link: `/modules/md-analysis/clustering` },
              ],
            },
            {
              text: `Dynamics & Optimization`,
              collapsed: false,
              items: [
                { text: `Trajectories`, link: `/modules/dynamics/trajectories` },
                { text: `Optimization`, link: `/modules/dynamics/optimization` },
              ],
            },
            {
              text: `Analysis & Spectroscopy`,
              collapsed: false,
              items: [
                { text: `Spectroscopy`, link: `/modules/analysis/spectroscopy` },
                { text: `Phase Diagrams`, link: `/modules/analysis/phase-diagrams` },
                { text: `Composition`, link: `/modules/analysis/composition` },
                { text: `Periodic Table`, link: `/modules/analysis/periodic-table` },
              ],
            },
            {
              text: `Workflow`,
              collapsed: false,
              items: [
                { text: `Workflow Engine`, link: `/modules/workflow/workflow-engine` },
                { text: `Node Types`, link: `/modules/workflow/node-types` },
                { text: `Job Scripts`, link: `/modules/workflow/job-scripts` },
                {
                  text: `Project Dashboard`,
                  link: `/modules/workflow/project-dashboard`,
                },
              ],
            },
            {
              text: `AI & Language`,
              collapsed: false,
              items: [
                { text: `Chat System`, link: `/modules/ai/chat-system` },
                { text: `Workflow Tools`, link: `/modules/ai/workflow-tools` },
                { text: `Literature Import`, link: `/modules/ai/literature-import` },
              ],
            },
            {
              text: `Interaction`,
              collapsed: false,
              items: [
                {
                  text: `Gesture Tracking`,
                  link: `/modules/interaction/gesture-tracking`,
                },
                { text: `Voice Control`, link: `/modules/interaction/voice-control` },
                { text: `Atom Art`, link: `/modules/interaction/atom-art` },
              ],
            },
            {
              text: `Integrations`,
              collapsed: false,
              items: [
                {
                  text: `Density Visualization`,
                  link: `/modules/integrations/density-visualization`,
                },
                {
                  text: `Database Integration`,
                  link: `/modules/integrations/database-integration`,
                },
              ],
            },
            {
              text: `Server`,
              collapsed: false,
              items: [
                { text: `MCP Server`, link: `/modules/server/mcp-server` },
                { text: `REST API`, link: `/modules/server/rest-api` },
              ],
            },
          ],
        },
      ],

      '/developer/': [
        {
          text: `Developer Guide`,
          items: [
            { text: `Contributing`, link: `/developer/contributing` },
            { text: `Development Guide`, link: `/developer/development-guide` },
            { text: `Desktop Build`, link: `/developer/desktop-build` },
            { text: `Layout Patterns`, link: `/developer/layout-patterns` },
            { text: `Plotly Config`, link: `/developer/plotly-config` },
            { text: `API Layer Spec`, link: `/developer/api-layer-spec` },
          ],
        },
      ],

      '/reference/': [
        {
          text: `Reference`,
          items: [
            { text: `Configuration`, link: `/reference/configuration` },
            { text: `FAQ`, link: `/reference/faq` },
            { text: `Changelog`, link: `/reference/changelog` },
          ],
        },
      ],
    },

    // Built-in local search
    search: {
      provider: `local`,
      options: {
        detailedView: true,
      },
    },

    // Social links in navbar
    socialLinks: [
      { icon: `github`, link: `https://github.com/Hello-QM/catgo-LRG` },
    ],

    // Footer
    footer: {
      message: `Released under the MIT License.`,
      copyright: `Copyright 2024-present CatGo Contributors`,
    },

    // Edit link on each page
    editLink: {
      pattern: `https://github.com/Hello-QM/catgo-LRG/edit/main/docs/:path`,
      text: `Edit this page on GitHub`,
    },

    // "On this page" right sidebar heading depth
    outline: {
      level: [2, 3],
      label: `On this page`,
    },

    // Previous/Next links at page bottom
    docFooter: {
      prev: `Previous`,
      next: `Next`,
    },
  },
})
