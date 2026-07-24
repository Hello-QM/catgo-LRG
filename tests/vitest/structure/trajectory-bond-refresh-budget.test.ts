import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe(`exact prepared trajectory ownership`, () => {
  test(`retires cadence, stale publication, and object-frame cache symbols`, () => {
    const controller = readFileSync(
      `src/lib/structure/bond-computation-controller.svelte.ts`,
      `utf8`,
    )
    expect(controller).not.toContain(`TRAJ_BOND_REFRESH_EVERY`)
    expect(controller).not.toContain(`should_refresh_large_trajectory_bonds`)
    expect(controller).not.toContain(`compute_bond_connectivity_for_frame`)
    expect(controller).not.toContain(`traj_pending_frame`)
    expect(controller).not.toContain(`traj_in_flight_frame`)
    expect(controller).not.toContain(`frame_conn_cache`)
  })

  test(`scene has one bounded exact pipeline and no failure fallback`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const controller = readFileSync(
      `src/lib/structure/bond-computation-controller.svelte.ts`,
      `utf8`,
    )
    expect(scene).toContain(`create_prepared_frame_pipeline({`)
    expect(scene).toContain(`max_frames: 8`)
    expect(scene).toContain(`max_bytes: 96 * 1024 * 1024`)
    expect(scene).toContain(`max_in_flight: 1`)
    expect(scene).toContain(`prepared_render_packet = prepared.packet`)
    expect(scene).not.toMatch(/catch[\\s\\S]{0,300}trajectory_pipeline=legacy/)
    expect(controller).toContain(
      `let last_bond_structure = $state.raw<AnyStructure | null>(null)`,
    )
  })

  test(`live renderer ownership reconciles exact packets or installs legacy state`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const commit_start = scene.indexOf(
      `prepared_render_packet = prepared.packet`,
    )
    const commit_end = scene.indexOf(
      `trajectory_presentation_committer.publish(`,
      commit_start,
    )
    const commit = scene.slice(commit_start, commit_end)

    expect(commit).not.toContain(`packet_renderer_will_own`)
    expect(commit).not.toContain(`manager.begin_positions_batch()`)
    expect(scene).toContain(`let pending_prepared_presentation = $state.raw<`)
    expect(scene).toContain(`function install_direct_prepared_presentation(`)
    expect(scene).toContain(`trajectory_presentation_committer.reconcile(`)
    expect(scene).toContain(`manager_render_packet !== null &&`)
    expect(scene).toContain(`show_bulk_atoms && !webgl_suspended`)
    expect(scene).toContain(`bond_state.bond_connectivity =`)
    expect(scene).toContain(`manager.begin_positions_batch()`)
    expect(scene).toContain(
      `let atom_data_has_partial_occupancy = $derived(`,
    )
    const eligibility_start = scene.indexOf(
      `function packet_render_features_eligible`,
    )
    const eligibility_end = scene.indexOf(
      `let combined_packet_renderer_owned`,
      eligibility_start,
    )
    expect(scene.slice(eligibility_start, eligibility_end))
      .not.toContain(`atom_data.some(`)
  })

  test(`scene acknowledges unified packets only through guarded renderer sync`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const publication_start = scene.indexOf(
      `prepared_render_packet = prepared.packet`,
    )
    const publication_end = scene.indexOf(
      `report_buffer(false)`,
      publication_start,
    )
    const publication = scene.slice(publication_start, publication_end)
    expect(publication).toContain(`trajectory_presentation_committer.publish(`)
    expect(publication).not.toContain(
      `trajectory_render_diagnostics.record_presented(`,
    )
    expect(publication).not.toContain(`on_trajectory_frame_presented?.(`)

    expect(scene).toContain(
      `create_trajectory_presentation_committer({`,
    )
    expect(scene).toContain(
      `trajectory_presentation_committer.renderer_synced(`,
    )
    expect(scene).toContain(
      `on_packet_synced={handle_packet_synced}`,
    )
  })

  test(`scene clears presentation ownership on trajectory teardown and unmount`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const destroy_start = scene.indexOf(`onDestroy(() => {`)
    const destroy_end = scene.indexOf(`})`, destroy_start)
    expect(scene.slice(destroy_start, destroy_end)).toContain(
      `trajectory_presentation_committer.clear()`,
    )
    const teardown_start = scene.indexOf(
      `if (\n      !raw_packet || !raw_structure?.sites || !raw_positions ||`,
    )
    const teardown_end = scene.indexOf(`return`, teardown_start)
    expect(scene.slice(teardown_start, teardown_end)).toContain(
      `trajectory_presentation_committer.clear()`,
    )
    expect(scene.slice(teardown_start, teardown_end)).toContain(
      `pending_prepared_presentation = null`,
    )
  })

  test(`streamed current requests await their indexed source instead of relabeling displayed positions`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    expect(scene).toContain(
      `const current_source = getter?.(frame_idx) ??\n` +
      `      (requester ? null : fallback_source)`,
    )
    expect(scene).toContain(
      `positions_version: current_source?.positions_version ??\n` +
      `        raw_packet.frame.positions_version`,
    )
    expect(scene).toContain(
      `prepare: () => prepare_source(frame_idx, current_source)`,
    )
    expect(scene).toContain(
      `prepared_pipeline.begin_request(current_key, frame_count)`,
    )
  })

  test(`buffer readiness ignores callbacks from an obsolete complete key`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const report_start = scene.indexOf(
      `const report_buffer = (preparing: boolean) => {`,
    )
    const report_end = scene.indexOf(
      `report_buffer(true)`,
      report_start,
    )
    const report = scene.slice(report_start, report_end)
    expect(report).toContain(`latest_prepared_request_key`)
    expect(report).toContain(
      `same_prepared_frame_key(current_key, latest_prepared_request_key)`,
    )
    expect(report.indexOf(`same_prepared_frame_key`)).toBeLessThan(
      report.indexOf(`on_trajectory_buffer_state?.(`),
    )
  })

  test(`the local hardware gate always launches the reviewed source server`, () => {
    const config = readFileSync(`playwright.config.ts`, `utf8`)
    expect(config).toContain(
      `reuseExistingServer: !CI && !GPU_PERF_GATE`,
    )
  })

  test(`packet-owned playback renders the prepared exact graph directly`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    expect(scene).not.toContain(
      `trajectory_render_diagnostics.record_topology_upload(`,
    )
    expect(scene).toContain(
      `const packet_owned_graph = trajectory_frame_positions != null &&`,
    )
    expect(scene).toContain(
      `? upstream.bond_graph ?? null`,
    )
    expect(scene).toContain(
      `const bond_graph = packet_owned_graph ?? manager_bond_graph`,
    )
    expect(scene).toContain(`bond_graph,`)
  })

  test(`reports renderer and legacy publication spans for the real-file gate`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const renderer = readFileSync(
      `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`,
      `utf8`,
    )
    expect(renderer).toContain(
      `trajectory_render_diagnostics.record_bond_renderer_timings(`,
    )
    expect(scene).toContain(
      `trajectory_render_diagnostics.record_bond_manager_replace(`,
    )
    expect(scene).toContain(
      `trajectory_render_diagnostics.record_typed_direct_sync(`,
    )
    expect(scene).toContain(
      `trajectory_render_diagnostics.record_prepared_to_renderer_sync(`,
    )
  })

  test(`packet ownership does not force the legacy image-bond layout`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const picker_start = scene.indexOf(
      `// Mark GPU picker as dirty when atom data, bonds, or cutting visibility change.`,
    )
    const picker_end = scene.indexOf(
      `// Track which bonds are manual`,
      picker_start,
    )
    const picker_effect = scene.slice(picker_start, picker_end)
    expect(picker_effect).toContain(`if (!packet_picking_active) {`)
    expect(picker_effect.indexOf(`if (!packet_picking_active) {`))
      .toBeLessThan(picker_effect.indexOf(`const _ial = image_atom_layout`))

    expect(scene).toContain(
      `image_atom_layout={combined_packet_renderer_owned\n` +
      `            ? empty_image_atom_layout()\n` +
      `            : image_atom_layout}`,
    )
    expect(scene).toContain(
      `partner_drawn_lookup={combined_packet_renderer_owned\n` +
      `            ? null\n` +
      `            : partner_drawn_lookup}`,
    )
  })

  test(`packet ownership mirrors bonds only through the live legacy fallback`, () => {
    const scene = readFileSync(
      `src/lib/structure/StructureScene.svelte`,
      `utf8`,
    )
    const publication_start = scene.indexOf(
      `prepared_render_packet = prepared.packet`,
    )
    const publication_end = scene.indexOf(
      `trajectory_presentation_committer.publish(`,
      publication_start,
    )
    expect(scene.slice(publication_start, publication_end))
      .not.toContain(`bond_manager.replace_auto_bonds(`)

    const direct_start = scene.indexOf(
      `function install_direct_prepared_presentation(`,
    )
    const direct_end = scene.indexOf(
      `// Eligibility can change after publication`,
      direct_start,
    )
    expect(scene.slice(direct_start, direct_end)).toContain(
      `bond_manager.replace_auto_bonds(`,
    )

    const typed_start = scene.indexOf(
      `if (traj_positions != null) {`,
    )
    const conversion = scene.indexOf(
      `const topo = conn_to_typed_topology(`,
      typed_start,
    )
    const owned_guard = scene.indexOf(
      `if (packet_renderer_active_for_typed_direct) {`,
      typed_start,
    )
    expect(owned_guard).toBeGreaterThan(typed_start)
    expect(owned_guard).toBeLessThan(conversion)
    expect(scene).toContain(
      `packet_renderer_active_for_typed_direct =\n` +
      `      combined_packet_renderer_actually_owned`,
    )
    expect(scene).toContain(
      `if (typed_direct_active || packet_renderer_active_for_typed_direct) ` +
      `return EMPTY_SLOT_MAP`,
    )
  })
})
