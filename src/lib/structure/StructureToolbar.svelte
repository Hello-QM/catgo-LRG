<script lang="ts">
  /**
   * StructureToolbar.svelte — 工具栏组件
   *
   * 从 Structure.svelte 抽取的工具栏按钮和测量模式下拉菜单。
   * 包含: 重置相机、全屏、手势控制、铅笔模式 UI、
   * Build/Analysis/Workflow/IO/Server/Chat/Terminal 工具栏按钮、测量模式选择器。
   *
   * 面板组件 (BuildPane, AnalysisPane 等) 通过 children snippet 从 Structure.svelte 传入，
   * 因为这些面板对 Structure.svelte 的状态有重度依赖（bind:structure, callbacks 等），
   * 通过 children snippet 保持对父组件作用域的直接访问。
   */
  import type { Snippet } from 'svelte'
  import type { AnyStructure, ElementSymbol } from '$lib'
  import { Icon, toggle_fullscreen } from '$lib'
  import type { GestureConfig } from '$lib/gesture/gesture-types'
  import type { Measurement } from './index'
  import type { MolecularFragment } from './controllers/fragments'
  import type { PencilModeController } from './controllers/pencil-mode.svelte'
  import { type create_interaction_controller } from './controllers/interaction.svelte'
  import { structure_to_poscar_str } from './export'
  import { writeRemoteFile } from '$lib/api/hpc'
  import { click_outside, tooltip } from 'svelte-multiselect'
  import { chat_position, set_chat_position } from '$lib/chat/chat-state.svelte'
  import { STATIC_ONLY } from '$lib/api/config'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  let {
    // ── 只读状态 ──
    camera_has_moved = false,
    visible_buttons = false,
    hide_extra_tools = false,
    enable_measure_mode = false,
    fullscreen_toggle = undefined,
    hidden_toolbar_items = [] as string[],
    remote_origin = null,
    structure = undefined,
    molecular_fragments = [],
    reset_text = `Reset camera (or double-click)`,
    wrapper = undefined,

    // ── 铅笔控制器 (只读传入, 内部 getter/setter 可写) ──
    pencil,
    interaction,

    // ── 双向绑定状态 ($bindable) ──
    // 全屏
    fullscreen = $bindable(false),
    // 手势
    gesture_active = $bindable(false),
    gesture_config = $bindable({} as GestureConfig),
    gesture_art_mode = $bindable(false),
    show_gesture_settings = $bindable(false),
    // 铅笔
    selected_add_element = $bindable(`C` as ElementSymbol),
    periodic_table_visible = $bindable(false),
    selected_fragment = $bindable({} as MolecularFragment),
    // 面板开关
    build_pane_open = $bindable(false),
    analysis_pane_open = $bindable(false),
    workflow_pane_open = $bindable(false),
    io_pane_open = $bindable(false),
    server_pane_open = $bindable(false),
    plugin_hub_open = $bindable(false),
    large_system_mode = $bindable(false),
    webgpu_available = true,
    chat_pane_open = $bindable(false),
    // 测量
    measure_mode = $bindable<`distance` | `angle` | `dihedral`>(`distance`),
    measure_mode_active = $bindable(false),
    measure_menu_open = $bindable(false),
    measurements = $bindable<Measurement[]>([]),
    measured_sites = $bindable<number[]>([]),
    selected_measurement_id = $bindable<string | null>(null),
    selected_sites = $bindable<number[]>([]),
    current_continuous_measurement_sites = $bindable<number[]>([]),

    // ── 回调函数 ──
    reset_camera = () => {},
    delete_measurement = (_id: string) => {},
    delete_selected_atoms = () => {},
    on_popout_chat = undefined as (() => void) | undefined,
    on_upload_to_hpc = undefined as (() => void) | undefined,
    on_open_terminal = undefined as (() => void) | undefined,
    on_open_in_molstar = undefined as (() => void) | undefined,

    // ── 子组件 snippet (面板组件从 Structure.svelte 传入) ──
    children,
  }: {
    // 只读
    camera_has_moved?: boolean
    visible_buttons?: boolean
    hide_extra_tools?: boolean
    enable_measure_mode?: boolean
    fullscreen_toggle?: Snippet<[]> | boolean
    hidden_toolbar_items?: string[]
    remote_origin?: { session_id: string; file_path: string } | null
    structure?: AnyStructure
    molecular_fragments?: MolecularFragment[]
    reset_text?: string
    wrapper?: HTMLDivElement

    // 铅笔控制器
    pencil: PencilModeController
    interaction: ReturnType<typeof create_interaction_controller>

    // 双向绑定
    fullscreen?: boolean
    gesture_active?: boolean
    gesture_config?: GestureConfig
    gesture_art_mode?: boolean
    show_gesture_settings?: boolean
    selected_add_element?: ElementSymbol
    periodic_table_visible?: boolean
    selected_fragment?: MolecularFragment
    build_pane_open?: boolean
    analysis_pane_open?: boolean
    workflow_pane_open?: boolean
    io_pane_open?: boolean
    server_pane_open?: boolean
    plugin_hub_open?: boolean
    large_system_mode?: boolean
    webgpu_available?: boolean
    chat_pane_open?: boolean
    measure_mode?: `distance` | `angle` | `dihedral`
    measure_mode_active?: boolean
    measure_menu_open?: boolean
    measurements?: Measurement[]
    measured_sites?: number[]
    selected_measurement_id?: string | null
    selected_sites?: number[]
    current_continuous_measurement_sites?: number[]

    // 回调
    reset_camera?: () => void
    delete_measurement?: (id: string) => void
    delete_selected_atoms?: () => void
    on_popout_chat?: () => void
    on_upload_to_hpc?: () => void
    // Open a terminal as a pane-tree leaf (desktop). Replaces the old
    // side-panel terminal toggle.
    on_open_terminal?: () => void
    on_open_in_molstar?: () => void

    // 子组件 snippet
    children?: Snippet
  } = $props()

  // Touch-capability detection for the touch-mode buttons. `any-pointer: coarse`
  // is true when ANY available pointer is coarse (finger/stylus) — so it also
  // catches hybrid devices (touch laptops, a tablet with a mouse attached) that
  // `pointer: coarse` (primary pointer only) would miss. Kept reactive so it
  // updates if an input device is plugged/unplugged.
  let has_touch = $state(false)
  $effect(() => {
    if (typeof window === `undefined`) return
    const coarse = window.matchMedia?.(`(any-pointer: coarse)`)
    const update = () => {
      has_touch = (coarse?.matches ?? false) ||
        (typeof navigator !== `undefined` && navigator.maxTouchPoints > 0)
    }
    update()
    coarse?.addEventListener?.(`change`, update)
    return () => coarse?.removeEventListener?.(`change`, update)
  })
</script>

<section class:visible={visible_buttons} class="control-buttons">
  {#if visible_buttons}
    <!-- === View / Navigation === -->
    {#if camera_has_moved}
      <button class="reset-camera" onclick={reset_camera} title={reset_text === `Reset camera (or double-click)` ? t('structure.reset_camera') : reset_text}>
        <Icon icon="Reset" />
      </button>
    {/if}
    {#if fullscreen_toggle}
      <button
        type="button"
        onclick={() => fullscreen_toggle && toggle_fullscreen(wrapper)}
        title={fullscreen ? t('structure.exit_fullscreen') : t('structure.enter_fullscreen')}
        aria-pressed={fullscreen}
        class="fullscreen-toggle"
        style="padding: 0"
        {@attach tooltip()}
      >
        {#if typeof fullscreen_toggle === `function`}
          {@render fullscreen_toggle()}
        {:else}
          <Icon icon="{fullscreen ? `Exit` : ``}Fullscreen" />
        {/if}
      </button>
    {/if}

    <!-- === Gesture Control === -->
    {#if !hidden_toolbar_items.includes('gesture')}
    <span class="struct-toolbar-tooltip-wrap">
      <button
        type="button"
        onclick={() => {
          gesture_active = !gesture_active
          gesture_config = { ...gesture_config, enabled: gesture_active }
        }}
        class="gesture-toggle"
        class:active={gesture_active}
        aria-pressed={gesture_active}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
          <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
          <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
          <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
      </button>
      <span class="struct-toolbar-tooltip" role="tooltip">{gesture_active ? t('structure.disable_gesture') : t('structure.enable_gesture')}</span>
    </span>
    {#if gesture_active}
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => { gesture_art_mode = !gesture_art_mode }}
          class="gesture-toggle art"
          class:active={gesture_art_mode}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="13.5" cy="6.5" r="2.5" />
            <circle cx="17" cy="15" r="1.5" />
            <circle cx="8.5" cy="14.5" r="1.5" />
            <circle cx="6.5" cy="8" r="1.5" />
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
          </svg>
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{gesture_art_mode ? t('structure.exit_art_mode') : t('structure.enter_art_mode')}</span>
      </span>
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => { show_gesture_settings = !show_gesture_settings }}
          class="gesture-toggle settings"
          class:active={show_gesture_settings}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{show_gesture_settings ? t('structure.close_voice_settings') : t('structure.open_voice_settings')}</span>
      </span>
    {/if}
    {/if}

    <!-- === Touch interaction modes (no modifier keys on touch devices) === -->
    {#if has_touch}
      <div class="touch-mode-container">
        <span class="struct-toolbar-tooltip-wrap">
          <button
            type="button"
            class="touch-mode-toggle"
            class:active={interaction.touch_mode === `box`}
            aria-pressed={interaction.touch_mode === `box`}
            onclick={() => interaction.touch_mode = interaction.touch_mode === `box` ? `none` : `box`}
          >{t('structure.touch_box_select')}</button>
          <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.touch_box_select_hint')}</span>
        </span>
        <span class="struct-toolbar-tooltip-wrap">
          <button
            type="button"
            class="touch-mode-toggle"
            class:active={interaction.touch_mode === `move`}
            aria-pressed={interaction.touch_mode === `move`}
            onclick={() => interaction.touch_mode = interaction.touch_mode === `move` ? `none` : `move`}
          >{t('structure.touch_move_atoms')}</button>
          <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.touch_move_atoms_hint')}</span>
        </span>
        <span class="struct-toolbar-tooltip-wrap">
          <button
            type="button"
            class="touch-mode-toggle"
            class:active={interaction.touch_mode === `rotate`}
            aria-pressed={interaction.touch_mode === `rotate`}
            onclick={() => interaction.touch_mode = interaction.touch_mode === `rotate` ? `none` : `rotate`}
          >{t('structure.touch_rotate_atoms')}</button>
          <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.touch_rotate_atoms_hint')}</span>
        </span>
        <span class="struct-toolbar-tooltip-wrap">
          <button
            type="button"
            class="touch-mode-toggle touch-delete"
            disabled={selected_sites.length === 0}
            aria-label={t('structure.touch_delete_atoms')}
            onclick={() => delete_selected_atoms()}
          >{t('structure.touch_delete_atoms')}</button>
          <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.touch_delete_atoms_hint')}</span>
        </span>
      </div>
    {/if}

    <!-- === Structure Editing (Pencil Mode) === -->
    <div class="pencil-mode-container">
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => {
            pencil.pencil_mode_active = !pencil.pencil_mode_active
            if (!pencil.pencil_mode_active) {
              pencil.pencil_drag_active = false
              pencil.pencil_anchor_idx = null
              pencil.pencil_ghost_atom = null
            }
          }}
          class="pencil-toggle"
          class:active={pencil.pencil_mode_active}
          aria-pressed={pencil.pencil_mode_active}
        >
          <Icon icon="Pencil" style={pencil.pencil_mode_active ? "color: var(--accent-color, #007acc)" : ""} />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{pencil.pencil_mode_active ? t('structure.exit_draw_mode') : t('structure.draw_mode_hint')}</span>
      </span>
      {#if pencil.pencil_mode_active}
        <button
          type="button"
          aria-label={t('structure.exit_draw_mode_btn')}
          title={t('structure.exit_draw_mode_btn')}
          onclick={() => {
            pencil.pencil_mode_active = false
            pencil.pencil_drag_active = false
            pencil.pencil_anchor_idx = null
            pencil.pencil_ghost_atom = null
          }}
          style="color: var(--accent-color, #007acc);"
        >
          <Icon icon="Cross" />
        </button>
      {/if}
      <!-- Pencil mode selector (atoms vs fragments) — dropdown below button -->
      {#if pencil.pencil_mode_active}
        <div class="pencil-mode-selector">
          <div class="mode-toggle">
            <button
              type="button"
              class="mode-btn"
              class:active={pencil.pencil_add_mode === 'atom'}
              onclick={() => pencil.pencil_add_mode = 'atom'}
              title={t('structure.add_atoms')}
            >
              {t('common.atoms')}
            </button>
            <button
              type="button"
              class="mode-btn"
              class:active={pencil.pencil_add_mode === 'fragment'}
              onclick={() => { pencil.pencil_add_mode = 'fragment'; pencil.selected_bonds = []; pencil.bond_first_atom = null }}
              title={t('structure.add_fragments')}
            >
              {t('structure.fragments')}
            </button>
            <button
              type="button"
              class="mode-btn"
              class:active={pencil.pencil_add_mode === 'bonds'}
              onclick={() => { pencil.pencil_add_mode = 'bonds'; pencil.selected_bonds = []; pencil.bond_first_atom = null }}
              title={t('structure.add_remove_bonds')}
            >
              {t('structure.bonds')}
            </button>
          </div>
          {#if pencil.pencil_add_mode === 'bonds'}
            <div class="bond-mode-status">
              {#if pencil.selected_bonds.length > 0}
                <span style="color: var(--warning-color)">{t('structure.bonds_selected', { n: pencil.selected_bonds.length })}</span> — {t('structure.press_delete_to_remove')}
              {:else if pencil.bond_first_atom !== null}
                {t('structure.click_second_atom')}
              {:else}
                {t('structure.click_atom_or_bond')}
              {/if}
            </div>
          {/if}
          {#if pencil.pencil_add_mode === 'atom'}
            <div class="element-quick-selector">
              {#each [`H`, `C`, `N`, `O`, `S`, `F`, `Cl`, `Br`] as elem}
                <button
                  type="button"
                  class="element-btn"
                  class:selected={selected_add_element === elem}
                  onclick={() => selected_add_element = elem as ElementSymbol}
                  title={t('structure.add_elem_atoms', { elem })}
                >
                  {elem}
                </button>
              {/each}
              <button
                type="button"
                class="element-btn more-elements"
                onclick={() => periodic_table_visible = true}
                title={t('structure.select_from_pt')}
              >
                ···
              </button>
            </div>
          {:else if pencil.pencil_add_mode === 'fragment'}
            <div class="fragment-selector">
              <div class="fragment-categories">
                {#each ['ring', 'alkyl', 'chain', 'functional'] as cat}
                  {@const cat_fragments = molecular_fragments.filter(f => f.category === cat)}
                  {#if cat_fragments.length > 0}
                    <span class="category-label">{cat === 'alkyl' ? t('structure.alkyl') : cat === 'ring' ? t('structure.rings') : cat === 'chain' ? t('structure.chains') : t('structure.functional')}</span>
                    {#each cat_fragments as frag}
                      <button
                        type="button"
                        class="fragment-btn"
                        class:selected={selected_fragment.name === frag.name}
                        onclick={() => selected_fragment = frag}
                        title={`${frag.name} (${frag.formula})`}
                      >
                        {frag.name}
                      </button>
                    {/each}
                  {/if}
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- === Large-system performance mode (always visible — also in trajectory/large views) === -->
    <span class="struct-toolbar-tooltip-wrap">
      <button
        type="button"
        disabled={!webgpu_available}
        onclick={() => { if (webgpu_available) large_system_mode = !large_system_mode }}
        class="build-tools-toggle"
        class:active={large_system_mode}
        aria-pressed={large_system_mode}
      >
        <Icon icon="Gauge" />
      </button>
      <span class="struct-toolbar-tooltip" role="tooltip">{webgpu_available ? t('structure.large_system_mode') : t('structure.large_system_mode_unavailable')}</span>
    </span>

    {#if !hide_extra_tools}
      <!-- === Build Tools === -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => { build_pane_open = !build_pane_open }}
          class="build-tools-toggle"
          class:active={build_pane_open}
        >
          <Icon icon="Hammer" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.build_tools')}</span>
      </span>

      <!-- === Analysis Tools === -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => { analysis_pane_open = !analysis_pane_open }}
          class="build-tools-toggle"
          class:active={analysis_pane_open}
        >
          <Icon icon="ChartLine" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.analysis_tools')}</span>
      </span>

      {#if on_open_in_molstar}
      <!-- === Open current structure in the Mol* bio viewer === -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => on_open_in_molstar?.()}
          class="build-tools-toggle"
        >
          <Icon icon="Dna" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.bio_open_in_molstar')}</span>
      </span>
      {/if}

      {#if !hidden_toolbar_items.includes('workflow') && !STATIC_ONLY}
      <!-- === Workflow === -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => { workflow_pane_open = !workflow_pane_open }}
          class="build-tools-toggle"
          class:active={workflow_pane_open}
        >
          <Icon icon="Workflow" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('common.workflow')}</span>
      </span>
      {/if}

      <!-- === IO (Import/Export) === -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => { io_pane_open = !io_pane_open }}
          class="build-tools-toggle"
          class:active={io_pane_open}
        >
          <Icon icon="FileIO" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.import_export')}</span>
      </span>

      {#if !hidden_toolbar_items.includes('server') && !STATIC_ONLY}
      <!-- === Server (HPC) === -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => { server_pane_open = !server_pane_open }}
          class="build-tools-toggle"
          class:active={server_pane_open}
        >
          <Icon icon="Server" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.server_hpc')}</span>
      </span>
      <!-- === Upload current structure to HPC === -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => on_upload_to_hpc?.()}
          class="build-tools-toggle"
        >
          <Icon icon="Cloud" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.upload_to_hpc')}</span>
      </span>
      {/if}

      {#if !hidden_toolbar_items.includes('plugin_hub') && !STATIC_ONLY}
      <!-- === Plugin Hub === -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => { plugin_hub_open = !plugin_hub_open }}
          class="build-tools-toggle"
          class:active={plugin_hub_open}
        >
          <Icon icon="PluginHub" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.plugin_hub')}</span>
      </span>
      {/if}

      {#if !hidden_toolbar_items.includes('chat')}
      <!-- === AI Chat === -->
      <!-- Shown in STATIC_ONLY too: CatBot runs the client-direct tool-calling
           loop in-browser (no backend) under static deploys. See is_client_direct. -->

      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => {
            if (chat_position.value === `popout`) set_chat_position(`right`)
            chat_pane_open = !chat_pane_open
          }}
          class="build-tools-toggle"
          class:active={chat_pane_open}
        >
          <Icon icon="Chat" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.ai_assistant')}</span>
      </span>
      {/if}

      {#if !hidden_toolbar_items.includes('terminal') && !STATIC_ONLY}
      <!-- === Terminal === — opens a terminal pane-tree leaf (no longer a
           side-panel toggle). -->
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => on_open_terminal?.()}
          class="build-tools-toggle"
        >
          <Icon icon="Terminal" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.open_terminal')}</span>
      </span>
      {/if}

      <!-- === Push structure back to remote === -->
      {#if remote_origin && structure}
        <button
          type="button"
          onclick={async () => {
            if (!remote_origin || !structure) return
            try {
              const content = structure_to_poscar_str(structure)
              const result = await writeRemoteFile(remote_origin.session_id, remote_origin.file_path, content)
              if (result.success) {
                console.log(`Saved to ${remote_origin.file_path}`)
              }
            } catch (e) {
              console.error(`Push-back failed:`, e)
            }
          }}
          title={t('structure.save_back_to', { path: remote_origin.file_path })}
          class="build-tools-toggle push-back-btn"
          {@attach tooltip()}
        >
          &#x21E7;
        </button>
      {/if}

      <!-- [2025-02] Removed Lattice Editor and Adsorption Sites toolbar buttons
           to reduce toolbar clutter. Functionality preserved in Build dropdown pane. -->
    {/if}

    <!-- === Analysis & Computation: Measurement Mode === -->
    {#if enable_measure_mode}
      <div
        class="measure-mode-dropdown"
        {@attach click_outside({ callback: () => measure_menu_open = false })}
      >
        <span class="struct-toolbar-tooltip-wrap">
          <button
            onclick={() => (measure_menu_open = !measure_menu_open)}
            class="view-mode-button"
            class:active={measure_menu_open || measure_mode_active}
            aria-expanded={measure_menu_open}
          >
            {#if measure_mode_active}
              <Icon
                icon={({ distance: `Ruler`, angle: `Angle`, dihedral: `Angle` } as const)[measure_mode]}
                style="color: var(--accent-color, #007acc)"
              />
            {:else if selected_sites.length > 0}
              <span class="selection-limit-text">
                {selected_sites.length}
              </span>
            {:else}
              <Icon
                icon={({ distance: `Ruler`, angle: `Angle`, dihedral: `Angle` } as const)[measure_mode]}
              />
            {/if}
          </button>
          <span class="struct-toolbar-tooltip" role="tooltip">{measure_mode_active
            ? t('structure.continuous_mode_on', { mode: measure_mode })
            : selected_sites.length > 0
              ? t('structure.atoms_selected_click', { n: selected_sites.length })
              : t('structure.select_atoms_then_click')}</span>
        </span>
        {#if measure_mode_active}
          <button
            type="button"
            aria-label={t('structure.exit_continuous_mode')}
            title={t('structure.exit_continuous_mode')}
            onclick={() => {
              measure_mode_active = false
              current_continuous_measurement_sites = []
            }}
            style="color: var(--accent-color, #007acc);"
          >
            <Icon icon="Cross" />
          </button>
        {:else if (selected_sites?.length ?? 0) > 0}
          <button
            type="button"
            aria-label={t('structure.clear_selection')}
            title={t('structure.clear_selection')}
            onclick={() => selected_sites = []}
          >
            <Icon icon="Cross" />
          </button>
        {/if}
        {#if measurements.length > 0}
          <button
            type="button"
            aria-label={t('structure.clear_all_measurements')}
            title={t('structure.clear_all_measurements')}
            onclick={() => {
              measurements = []
              measured_sites = []
              selected_measurement_id = null
            }}
            style="display: flex; align-items: center; gap: 2px;"
          >
            <Icon icon="Ruler" style="transform: scale(0.8)" />
            <span style="font-weight: bold;">×</span>
          </button>
        {/if}
        {#if measure_menu_open}
          {@const measure_options = [
            { mode: `distance` as const, icon: `Ruler` as const, label: t('structure.distance'), scale: 1.1, min_atoms: 2 },
            { mode: `angle` as const, icon: `Angle` as const, label: t('structure.angle'), scale: 1.3, min_atoms: 3 },
            { mode: `dihedral` as const, icon: `Angle` as const, label: t('structure.dihedral'), scale: 1.3, min_atoms: 4 },
          ]}
          <div class="view-mode-dropdown">
            {#each measure_options as { mode, icon, label, scale, min_atoms } (mode)}
              <button
                class="view-mode-option"
                class:selected={measure_mode === mode && measure_mode_active}
                title={selected_sites.length >= min_atoms
                  ? t('structure.measure_label', { label })
                  : t('structure.enter_label_mode', { label })}
                onclick={(event) => {
                  event.stopPropagation()
                  measure_mode = mode
                  measure_menu_open = false

                  // If enough atoms selected, measure them immediately
                  if (selected_sites.length >= min_atoms) {
                    const sites_to_measure = [...selected_sites]
                    measure_mode_active = false
                    const new_measurements: Measurement[] = []
                    if (mode === `distance`) {
                      for (let i = 0; i < sites_to_measure.length; i++) {
                        for (let j = i + 1; j < sites_to_measure.length; j++) {
                          new_measurements.push({
                            id: `meas_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${i}_${j}`,
                            type: mode,
                            sites: [sites_to_measure[i], sites_to_measure[j]]
                          })
                        }
                      }
                    } else {
                      new_measurements.push({
                        id: `meas_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                        type: mode,
                        sites: sites_to_measure
                      })
                    }
                    measurements = [...measurements, ...new_measurements]
                    selected_sites = []
                  } else {
                    // Not enough atoms - enter continuous measurement mode
                    measure_mode_active = true
                    current_continuous_measurement_sites = []
                  }
                }}
              >
                <Icon {icon} style="transform: scale({scale})" />
                <span>{label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if selected_measurement_id}
      {@const selected_meas = measurements.find(m => m.id === selected_measurement_id)}
      {#if selected_meas}
        <div class="selected-measurement-indicator">
          <span>{t('structure.type_selected', { type: selected_meas.type === 'distance' ? t('structure.distance') : selected_meas.type === 'angle' ? t('structure.angle') : t('structure.dihedral') })}</span>
          <button
            type="button"
            aria-label={t('structure.delete_measurement')}
            title={t('structure.delete_measurement')}
            onclick={() => delete_measurement(selected_measurement_id!)}
          >
            <Icon icon="Close" style="transform: scale(0.8)" />
          </button>
        </div>
      {/if}
    {/if}

    <!-- 面板组件通过 children snippet 从 Structure.svelte 传入 -->
    {@render children?.()}
  {/if}
</section>

<style>
  /* === 工具栏容器 === */
  section.control-buttons {
    position: absolute;
    display: flex;
    flex-wrap: wrap;
    top: var(--struct-buttons-top, var(--ctrl-btn-top, 1ex));
    right: var(--struct-buttons-right, var(--ctrl-btn-right, 1ex));
    left: var(--struct-buttons-left, 1ex);
    gap: clamp(6pt, 1cqmin, 9pt);
    justify-content: flex-end;
    align-items: flex-start;
    /* buttons need higher z-index than StructureLegend to make info/controls panes occlude legend */
    /* we also need crazy high z-index to make info/control pane occlude threlte/extras' <HTML> elements for site labels */
    z-index: var(--struct-buttons-z-index, 100000000);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  section.control-buttons.visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* === 按钮基础样式 === */
  section.control-buttons > :global(button),
  section.control-buttons :global(.pane-toggle),
  section.control-buttons .view-mode-button,
  section.control-buttons .build-tools-toggle {
    background-color: transparent;
    display: flex;
    align-items: center;
    padding: 4pt;
    font-size: clamp(0.9em, 1.8cqmin, 1.3em);
    border-radius: 3pt;
    transition: background-color 0.2s;
  }
  section.control-buttons > :global(button:hover),
  section.control-buttons :global(.pane-toggle:hover),
  section.control-buttons .view-mode-button:hover,
  section.control-buttons .build-tools-toggle:hover:not(:disabled) {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  section.control-buttons .build-tools-toggle:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  section.control-buttons .build-tools-toggle.active,
  section.control-buttons .view-mode-button.active,
  section.control-buttons :global(.pane-toggle.active) {
    color: var(--accent-color, #007acc);
    background-color: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
  }

  /* Pulsing dot on toolbar button when terminal is minimized */
  .build-tools-toggle.minimized-indicator {
    position: relative;
  }
  .build-tools-toggle.minimized-indicator::after {
    content: '';
    position: absolute;
    top: 2px;
    right: 2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-color, #3b82f6);
    animation: pulse-dot 2s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .struct-toolbar-tooltip-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .struct-toolbar-tooltip {
    position: absolute;
    left: 50%;
    top: calc(100% + 8px);
    transform: translateX(-50%) translateY(-4px);
    padding: 7px 12px;
    border-radius: 7px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(17, 17, 17, 0.96);
    color: #f5f5f5;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.3);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.25;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    z-index: 100000010;
    transition: opacity 0.14s ease, transform 0.14s ease, visibility 0.14s ease;
  }
  .struct-toolbar-tooltip-wrap:hover .struct-toolbar-tooltip,
  .struct-toolbar-tooltip-wrap:focus-within .struct-toolbar-tooltip {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
  }
  .struct-toolbar-tooltip-wrap:has(.active) .struct-toolbar-tooltip,
  .struct-toolbar-tooltip-wrap:has([aria-expanded='true']) .struct-toolbar-tooltip,
  .struct-toolbar-tooltip-wrap:has([aria-pressed='true']) .struct-toolbar-tooltip {
    opacity: 0;
    visibility: hidden;
  }
  .struct-toolbar-tooltip::before {
    content: '';
    position: absolute;
    left: 50%;
    bottom: 100%;
    width: 9px;
    height: 9px;
    background: inherit;
    border-left: 1px solid rgba(255, 255, 255, 0.12);
    border-top: 1px solid rgba(255, 255, 255, 0.12);
    transform: translate(-50%, 50%) rotate(45deg);
  }

  /* === 下拉菜单样式 (匹配 Trajectory dropdown UI) === */
  .view-mode-dropdown {
    position: absolute;
    top: 115%;
    right: 0;
    max-width: calc(100vw - 24px);
    overflow-x: auto;
    background: var(--surface-bg);
    border-radius: 4px;
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
    font-size: 0.9rem;
  }
  .view-mode-option {
    display: flex;
    align-items: center;
    gap: 1ex;
    width: 100%;
    padding: var(--trajectory-view-mode-option-padding, 5pt);
    box-sizing: border-box;
    background: transparent;
    border-radius: 0;
    text-align: left;
    transition: background-color 0.15s ease;
  }
  .view-mode-option:first-child {
    border-top-left-radius: 3px;
    border-top-right-radius: 3px;
  }
  .view-mode-option.selected {
    color: var(--accent-color);
  }
  .view-mode-option span {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  /* === 测量模式 === */
  .measure-mode-dropdown {
    display: flex;
    position: relative;
    gap: 4pt;
  }
  .selected-measurement-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(255, 204, 0, 0.3);
    border: 1px solid var(--warning-color, #ffcc00);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 0.9em;
    color: var(--struct-text-color);
  }
  .selected-measurement-indicator button {
    background: transparent;
    border: none;
    padding: 2px;
    cursor: pointer;
    display: flex;
    align-items: center;
    color: inherit;
    opacity: 0.7;
  }
  .selected-measurement-indicator button:hover {
    opacity: 1;
  }
  .selection-limit-text {
    font-weight: bold;
    font-size: 0.9em;
    color: var(--accent-color, var(--error-color, #ff6b6b));
    min-width: 2.5em;
    text-align: center;
  }

  /* === 铅笔/画模式样式 === */
  .pencil-mode-container {
    display: flex;
    position: relative;
    gap: 4pt;
  }
  .pencil-toggle {
    background-color: transparent;
    display: flex;
    align-items: center;
    padding: 4pt;
    font-size: clamp(0.9em, 1.8cqmin, 1.3em);
    border-radius: 3pt;
    transition: background-color 0.2s;
  }
  .pencil-toggle:hover {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  .pencil-toggle.active {
    color: var(--accent-color, #007acc);
    background-color: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
  }
  .touch-mode-container {
    display: flex;
    position: relative;
    gap: 4pt;
  }
  .touch-mode-toggle {
    background-color: transparent;
    padding: 4pt 7pt;
    font-size: clamp(0.8em, 1.6cqmin, 1.1em);
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 4pt;
    white-space: nowrap;
    transition: background-color 0.2s, color 0.2s;
  }
  .touch-mode-toggle:hover {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  .touch-mode-toggle.active {
    color: var(--accent-color, #007acc);
    border-color: var(--accent-color, #007acc);
    background-color: color-mix(in srgb, var(--accent-color, #007acc) 18%, transparent);
  }
  .touch-mode-toggle.touch-delete:not(:disabled) {
    color: var(--error-color, #ef4444);
    border-color: color-mix(in srgb, var(--error-color, #ef4444) 45%, transparent);
  }
  .touch-mode-toggle:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* === 手势控制切换 === */
  .gesture-toggle {
    background-color: transparent;
    display: flex;
    align-items: center;
    padding: 4pt;
    border-radius: 3pt;
    transition: all 0.2s;
    color: var(--text-color, #ccc);
  }
  .gesture-toggle:hover {
    background-color: color-mix(in srgb, #00fff7 15%, transparent);
    color: #00fff7;
  }
  .gesture-toggle.active {
    color: #00fff7;
    background-color: color-mix(in srgb, #00fff7 15%, transparent);
    box-shadow: 0 0 8px rgba(0, 255, 247, 0.3);
  }
  .gesture-toggle.art.active {
    color: #ff00ff;
    background-color: color-mix(in srgb, #ff00ff 15%, transparent);
    box-shadow: 0 0 8px rgba(255, 0, 255, 0.3);
  }
  .gesture-toggle.settings {
    border: 1px solid rgba(0, 255, 247, 0.2);
  }
  .gesture-toggle.settings.active {
    border-color: rgba(0, 255, 247, 0.5);
  }

  /* === 元素快速选择器 === */
  .element-quick-selector {
    display: flex;
    gap: 2px;
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: var(--border-radius, 6px);
    padding: 2px 4px;
  }
  .element-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .element-btn:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
    border-color: color-mix(in srgb, currentColor 20%, transparent);
  }
  .element-btn.selected {
    background: var(--accent-color, #007acc);
    color: white;
    border-color: var(--accent-color, #007acc);
  }

  /* === 铅笔模式选择器 (atoms vs fragments vs bonds) === */
  .pencil-mode-selector {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: var(--border-radius, 6px);
    padding: 4px;
    width: max-content;
    max-width: min(420px, calc(100vw - 24px));
    max-height: calc(100vh - 96px);
    overflow-x: auto;
    overflow-y: auto;
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
    font-size: 0.9rem;
  }
  .mode-toggle {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border-color, #333);
    padding-bottom: 4px;
    margin-bottom: 2px;
  }
  .mode-btn {
    flex: 1;
    padding: 4px 8px;
    font-weight: 600;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    color: var(--text-color-muted, #888);
  }
  .mode-btn:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .mode-btn.active {
    background: var(--accent-color, #007acc);
    color: white;
    border-color: var(--accent-color, #007acc);
  }

  /* === 键编辑状态 === */
  .bond-mode-status {
    font-size: 0.72em;
    color: var(--text-color-muted, #aaa);
    padding: 4px 6px;
    text-align: center;
    line-height: 1.4;
  }

  /* === 片段选择器 === */
  .fragment-selector {
    max-width: min(400px, calc(100vw - 36px));
  }
  .fragment-categories {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    align-items: center;
  }
  .category-label {
    font-size: 0.65em;
    font-weight: 600;
    color: var(--text-color-muted, #888);
    text-transform: uppercase;
    padding: 2px 4px;
    margin-left: 4px;
  }
  .category-label:first-child {
    margin-left: 0;
  }
  .fragment-btn {
    padding: 3px 8px;
    font-size: 0.75em;
    font-weight: 500;
    background: transparent;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }
  .fragment-btn:hover {
    background: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
    border-color: var(--accent-color, #007acc);
  }
  .fragment-btn.selected {
    background: var(--accent-color, #007acc);
    color: white;
    border-color: var(--accent-color, #007acc);
  }

  @media (max-width: 560px) {
    .pencil-mode-selector,
    .view-mode-dropdown {
      position: fixed;
      left: 50%;
      right: auto;
      top: 72px;
      transform: translateX(-50%);
      width: max-content;
      max-width: calc(100vw - 24px);
      z-index: 100000020;
    }
  }
</style>
