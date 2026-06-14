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
          { text: `指南`, link: `/zh/guide/overview` },
          { text: `教程`, link: `/zh/tutorials/basics/getting-started` },
          {
            text: `模块`,
            items: [
              { text: `概览`, link: `/zh/modules/` },
              {
                text: `核心`,
                items: [
                  { text: `结构查看器`, link: `/zh/modules/core/structure-viewer` },
                  { text: `文件 I/O`, link: `/zh/modules/core/file-io` },
                  { text: `键合`, link: `/zh/modules/core/bonding` },
                  { text: `设置`, link: `/zh/modules/core/settings` },
                ],
              },
              {
                text: `分析`,
                items: [
                  {
                    text: `电子结构`,
                    link: `/zh/modules/electronic/band-structure`,
                  },
                  { text: `MD 分析`, link: `/zh/modules/md-analysis/rdf` },
                  { text: `光谱分析`, link: `/zh/modules/analysis/spectroscopy` },
                ],
              },
              {
                text: `功能`,
                items: [
                  { text: `工作流引擎`, link: `/zh/modules/workflow/workflow-engine` },
                  { text: `AI 聊天`, link: `/zh/modules/ai/chat-system` },
                  { text: `手势追踪`, link: `/zh/modules/interaction/gesture-tracking` },
                  { text: `MCP 服务器`, link: `/zh/modules/server/mcp-server` },
                ],
              },
            ],
          },
          { text: `开发者`, link: `/zh/developer/contributing` },
          {
            text: `更多`,
            items: [
              { text: `图库`, link: `/zh/guide/gallery` },
              { text: `技巧与提示`, link: `/zh/guide/tips-and-tricks` },
              { text: `配置`, link: `/zh/reference/configuration` },
              { text: `FAQ`, link: `/zh/reference/faq` },
              { text: `更新日志`, link: `/zh/reference/changelog` },
            ],
          },
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: `入门`,
              items: [
                { text: `概览`, link: `/zh/guide/overview` },
                { text: `安装`, link: `/zh/guide/installation` },
                { text: `CatBot AI`, link: `/zh/guide/catbot` },
                { text: `图库`, link: `/zh/guide/gallery` },
                { text: `技巧与提示`, link: `/zh/guide/tips-and-tricks` },
              ],
            },
          ],

          '/zh/tutorials/': [
            {
              text: `教程`,
              link: `/zh/tutorials/`,
              items: [
                {
                  text: `基础`,
                  collapsed: false,
                  items: [
                    { text: `快速上手`, link: `/zh/tutorials/basics/getting-started` },
                  ],
                },
                {
                  text: `结构`,
                  collapsed: false,
                  items: [
                    { text: `构建表面 slab`, link: `/zh/tutorials/structures/building-slabs` },
                    { text: `结构优化`, link: `/zh/tutorials/structures/optimization` },
                    {
                      text: `数据库搜索`,
                      link: `/zh/tutorials/structures/database-search`,
                    },
                  ],
                },
                {
                  text: `可视化`,
                  collapsed: false,
                  items: [
                    {
                      text: `电荷密度可视化`,
                      link: `/zh/tutorials/visualization/density-viz`,
                    },
                    { text: `轨迹`, link: `/zh/tutorials/visualization/trajectories` },
                  ],
                },
                {
                  text: `工作流`,
                  collapsed: false,
                  items: [
                    { text: `工作流`, link: `/zh/tutorials/workflows/workflows` },
                  ],
                },
                {
                  text: `电子结构分析`,
                  collapsed: false,
                  items: [
                    { text: `能带结构`, link: `/zh/tutorials/electronic/band-structure` },
                    { text: `DOS 分析`, link: `/zh/tutorials/electronic/dos-analysis` },
                    { text: `COHP 分析`, link: `/zh/tutorials/electronic/cohp-analysis` },
                  ],
                },
                {
                  text: `MD 分析`,
                  collapsed: false,
                  items: [
                    { text: `RDF 分析`, link: `/zh/tutorials/md-analysis/rdf-analysis` },
                    { text: `RMSD 与 RMSF`, link: `/zh/tutorials/md-analysis/rmsd-rmsf` },
                    {
                      text: `氢键检测`,
                      link: `/zh/tutorials/md-analysis/hbond-detection`,
                    },
                    {
                      text: `聚类与 PCA`,
                      link: `/zh/tutorials/md-analysis/clustering-pca`,
                    },
                  ],
                },
                {
                  text: `AI 功能`,
                  collapsed: false,
                  items: [
                    { text: `AI 聊天`, link: `/zh/tutorials/ai/ai-chat` },
                    { text: `文献导入`, link: `/zh/tutorials/ai/literature-import` },
                  ],
                },
                {
                  text: `交互`,
                  collapsed: false,
                  items: [
                    {
                      text: `手势与手部追踪`,
                      link: `/zh/tutorials/interaction/gesture-hand-tracking`,
                    },
                    { text: `语音控制`, link: `/zh/tutorials/interaction/voice-control` },
                  ],
                },
                {
                  text: `桌面端`,
                  collapsed: false,
                  items: [
                    { text: `桌面应用`, link: `/zh/tutorials/desktop/desktop-app` },
                  ],
                },
                {
                  text: `服务器`,
                  collapsed: false,
                  items: [
                    { text: `MCP 服务器`, link: `/zh/tutorials/server/mcp-server` },
                    { text: `服务器 API`, link: `/zh/tutorials/server/server-api` },
                  ],
                },
              ],
            },
          ],

          '/zh/modules/': [
            {
              text: `模块参考`,
              link: `/zh/modules/`,
              items: [
                {
                  text: `核心`,
                  collapsed: false,
                  items: [
                    { text: `结构查看器`, link: `/zh/modules/core/structure-viewer` },
                    { text: `文件 I/O`, link: `/zh/modules/core/file-io` },
                    { text: `晶格与晶胞`, link: `/zh/modules/core/lattice-cell` },
                    { text: `键合`, link: `/zh/modules/core/bonding` },
                    { text: `设置`, link: `/zh/modules/core/settings` },
                  ],
                },
                {
                  text: `晶体学`,
                  collapsed: false,
                  items: [
                    {
                      text: `表面与 slab`,
                      link: `/zh/modules/crystallography/surfaces-slabs`,
                    },
                    { text: `对称性`, link: `/zh/modules/crystallography/symmetry` },
                    { text: `超胞`, link: `/zh/modules/crystallography/supercells` },
                  ],
                },
                {
                  text: `电子结构`,
                  collapsed: false,
                  items: [
                    { text: `能带结构`, link: `/zh/modules/electronic/band-structure` },
                    { text: `态密度`, link: `/zh/modules/electronic/dos` },
                    { text: `COHP`, link: `/zh/modules/electronic/cohp` },
                  ],
                },
                {
                  text: `MD 分析`,
                  collapsed: false,
                  items: [
                    { text: `径向分布函数`, link: `/zh/modules/md-analysis/rdf` },
                    { text: `动力学（RMSD/RMSF）`, link: `/zh/modules/md-analysis/dynamics` },
                    { text: `密度分布`, link: `/zh/modules/md-analysis/density-profile` },
                    { text: `氢键`, link: `/zh/modules/md-analysis/hbonds` },
                    { text: `聚类与 PCA`, link: `/zh/modules/md-analysis/clustering` },
                  ],
                },
                {
                  text: `动力学与优化`,
                  collapsed: false,
                  items: [
                    { text: `轨迹`, link: `/zh/modules/dynamics/trajectories` },
                    { text: `优化`, link: `/zh/modules/dynamics/optimization` },
                  ],
                },
                {
                  text: `分析与光谱`,
                  collapsed: false,
                  items: [
                    { text: `光谱分析`, link: `/zh/modules/analysis/spectroscopy` },
                    { text: `相图`, link: `/zh/modules/analysis/phase-diagrams` },
                    { text: `组成`, link: `/zh/modules/analysis/composition` },
                    { text: `元素周期表`, link: `/zh/modules/analysis/periodic-table` },
                  ],
                },
                {
                  text: `工作流`,
                  collapsed: false,
                  items: [
                    { text: `工作流引擎`, link: `/zh/modules/workflow/workflow-engine` },
                    { text: `节点类型`, link: `/zh/modules/workflow/node-types` },
                    { text: `作业脚本`, link: `/zh/modules/workflow/job-scripts` },
                    {
                      text: `项目仪表盘`,
                      link: `/zh/modules/workflow/project-dashboard`,
                    },
                  ],
                },
                {
                  text: `AI 与语言`,
                  collapsed: false,
                  items: [
                    { text: `聊天系统`, link: `/zh/modules/ai/chat-system` },
                    { text: `工作流工具`, link: `/zh/modules/ai/workflow-tools` },
                    { text: `文献导入`, link: `/zh/modules/ai/literature-import` },
                  ],
                },
                {
                  text: `交互`,
                  collapsed: false,
                  items: [
                    {
                      text: `手势追踪`,
                      link: `/zh/modules/interaction/gesture-tracking`,
                    },
                    { text: `语音控制`, link: `/zh/modules/interaction/voice-control` },
                    { text: `Atom Art`, link: `/zh/modules/interaction/atom-art` },
                  ],
                },
                {
                  text: `集成`,
                  collapsed: false,
                  items: [
                    {
                      text: `密度可视化`,
                      link: `/zh/modules/integrations/density-visualization`,
                    },
                    {
                      text: `数据库集成`,
                      link: `/zh/modules/integrations/database-integration`,
                    },
                  ],
                },
                {
                  text: `服务器`,
                  collapsed: false,
                  items: [
                    { text: `MCP 服务器`, link: `/zh/modules/server/mcp-server` },
                    { text: `REST API`, link: `/zh/modules/server/rest-api` },
                  ],
                },
              ],
            },
          ],

          '/zh/developer/': [
            {
              text: `开发者指南`,
              items: [
                { text: `贡献指南`, link: `/zh/developer/contributing` },
                { text: `开发指南`, link: `/zh/developer/development-guide` },
                { text: `桌面端构建`, link: `/zh/developer/desktop-build` },
                { text: `布局模式`, link: `/zh/developer/layout-patterns` },
                { text: `Plotly 配置`, link: `/zh/developer/plotly-config` },
                { text: `API 层规范`, link: `/zh/developer/api-layer-spec` },
              ],
            },
          ],

          '/zh/reference/': [
            {
              text: `参考`,
              items: [
                { text: `配置`, link: `/zh/reference/configuration` },
                { text: `FAQ`, link: `/zh/reference/faq` },
                { text: `更新日志`, link: `/zh/reference/changelog` },
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
