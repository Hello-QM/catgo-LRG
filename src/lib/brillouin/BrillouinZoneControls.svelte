<script lang="ts">
  import { DraggablePane, SettingsSection } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { CameraProjection } from '$lib/settings'

  load_i18n_module('structure')

  let {
    controls_open = $bindable(false),
    bz_order = $bindable(1),
    surface_color = $bindable(`#4488ff`),
    surface_opacity = $bindable(0.3),
    edge_color = $bindable(`#000000`),
    edge_width = $bindable(0.05),
    show_vectors = $bindable(true),
    camera_projection = $bindable(`perspective`),
  }: {
    controls_open?: boolean
    bz_order?: number
    surface_color?: string
    surface_opacity?: number
    edge_color?: string
    edge_width?: number
    show_vectors?: boolean
    camera_projection?: CameraProjection
  } = $props()
</script>

<DraggablePane
  bind:show={controls_open}
  open_icon="Cross"
  closed_icon="Settings"
  pane_props={{ class: `bz-controls` }}
  toggle_props={{ class: `controls-toggle`, title: t('structure.brillouin_zone_controls') }}
>
  <SettingsSection
    title={t('structure.brillouin_zone_controls')}
    current_values={{ bz_order, show_vectors }}
    on_reset={() => {
      bz_order = 1
      show_vectors = true
    }}
    style="display: flex; gap: 2ex; flex-wrap: wrap"
  >
    <label>
      <span>{t('structure.order')}:</span>
      <select bind:value={bz_order}>
        <option value={1}>{t('structure.bz_order_1')}</option>
        <option value={2}>{t('structure.bz_order_2')}</option>
        <option value={3}>{t('structure.bz_order_3')}</option>
      </select>
    </label>
    <label>
      <span>{t('structure.show_vectors')}:</span>
      <input type="checkbox" bind:checked={show_vectors} />
    </label>
  </SettingsSection>

  <SettingsSection
    title={t('structure.surface')}
    current_values={{ surface_color, surface_opacity }}
    on_reset={() => {
      surface_color = `#4488ff`
      surface_opacity = 0.3
    }}
  >
    <label>
      <span>{t('structure.color')}:</span>
      <input type="color" bind:value={surface_color} />
    </label>
    <label>
      <span>{t('structure.opacity')}:</span>
      <input type="range" min="0" max="1" step="0.01" bind:value={surface_opacity} />
      <span class="value">{surface_opacity.toFixed(2)}</span>
    </label>
  </SettingsSection>

  <SettingsSection
    title={t('structure.edges')}
    current_values={{ edge_color, edge_width }}
    on_reset={() => {
      edge_color = `#000000`
      edge_width = 0.05
    }}
  >
    <label>
      <span>{t('structure.color')}:</span>
      <input type="color" bind:value={edge_color} />
    </label>
    <label>
      <span>{t('structure.width')}:</span>
      <input type="range" min="0.01" max="0.2" step="0.01" bind:value={edge_width} />
      <span class="value">{edge_width.toFixed(2)}</span>
    </label>
  </SettingsSection>

  <SettingsSection
    title={t('structure.camera')}
    current_values={{ camera_projection }}
    on_reset={() => {
      camera_projection = `perspective`
    }}
  >
    <label>
      <span>{t('structure.projection')}:</span>
      <select bind:value={camera_projection}>
        <option value="perspective">{t('structure.perspective')}</option>
        <option value="orthographic">{t('structure.orthographic')}</option>
      </select>
    </label>
  </SettingsSection>
</DraggablePane>
