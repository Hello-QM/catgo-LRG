<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { PymatgenStructure, Vec3 } from '$lib'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import {
    wasm_generate_slab_layers, wasm_slab_termination_info,
    is_ok, type SlabTermination,
  } from '$lib/structure/ferrox-wasm'
  import { matrix_to_params, ensure_right_handed } from '$lib/structure/lattice-ops'
  import { deduplicate_periodic_images } from '$lib/structure/pbc'
  import { parse_slab_gen_params } from './graph-model'
  import { apply_freeze_to_structure } from './freeze'

  load_i18n_module(`workflow`)

  /** Post-process WASM slab output — same steps as MillerSlabCutterPane */
  function postprocess_slab(raw: PymatgenStructure): PymatgenStructure {
    if (!raw?.lattice?.matrix) return raw
    const raw_matrix = raw.lattice.matrix as [Vec3, Vec3, Vec3]
    const { matrix, swapped } = ensure_right_handed(raw_matrix)
    const params = matrix_to_params(matrix)
    const [va, vb, vc] = matrix
    const cross_bc: Vec3 = [
      vb[1] * vc[2] - vb[2] * vc[1],
      vb[2] * vc[0] - vb[0] * vc[2],
      vb[0] * vc[1] - vb[1] * vc[0],
    ]
    const volume = Math.abs(va[0] * cross_bc[0] + va[1] * cross_bc[1] + va[2] * cross_bc[2])
    const sites = swapped && raw.sites
      ? raw.sites.map((s: any) => ({ ...s, abc: s.abc ? [s.abc[1], s.abc[0], s.abc[2]] : s.abc }))
      : raw.sites
    let result: PymatgenStructure = {
      ...raw,
      sites,
      lattice: {
        ...raw.lattice,
        matrix,
        a: params.a, b: params.b, c: params.c,
        alpha: params.alpha, beta: params.beta, gamma: params.gamma,
        volume,
        pbc: [true, true, false] as [boolean, boolean, boolean],
      },
    }
    result = deduplicate_periodic_images(result as any) as PymatgenStructure
    return result
  }

  interface Props {
    node_params: Record<string, unknown>
    upstream_structure_json: string | null
    on_expand?: () => void
    onstructure_generated?: (structure_json: string | null) => void
    onparam_update?: (key: string, value: unknown) => void
  }

  let { node_params, upstream_structure_json, on_expand, onstructure_generated, onparam_update }: Props = $props()

  /** When locked, preview shows the saved structure_json instead of regenerating */
  let is_locked = $derived(!!node_params.slab_locked)
  let locked_structure = $derived.by(() => {
    if (!is_locked) return null
    const json = node_params.structure_json as string | undefined
    if (!json) return null
    try { return JSON.parse(json) as PymatgenStructure }
    catch { return null }
  })

  function unlock() {
    onparam_update?.(`slab_locked`, false)
  }

  let parsed = $derived(parse_slab_gen_params(node_params))

  let upstream_structure = $derived.by(() => {
    if (!upstream_structure_json) return null
    try { return JSON.parse(upstream_structure_json) as PymatgenStructure }
    catch { return null }
  })

  // Termination info (depends on bulk structure + miller only)
  let terminations = $state<SlabTermination[]>([])
  let term_counter = 0
  let term_timer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    const _m = parsed.miller
    const struct = upstream_structure
    if (term_timer) clearTimeout(term_timer)

    if (!struct) {
      terminations = []
      return
    }

    const my_id = ++term_counter
    term_timer = setTimeout(async () => {
      try {
        const result = await wasm_slab_termination_info(struct, _m)
        if (term_counter !== my_id) return
        if (is_ok(result)) {
          terminations = result.ok
        } else {
          terminations = []
        }
      } catch {
        if (term_counter === my_id) terminations = []
      }
    }, 200)
  })

  // Clamp termination index to valid range
  let effective_termination = $derived(
    terminations.length > 0 ? Math.min(parsed.termination, terminations.length - 1) : 0
  )

  // Debounced slab generation
  let preview_structure = $state<PymatgenStructure | null>(null)
  let is_loading = $state(false)
  let error_msg = $state<string | null>(null)
  let gen_counter = 0
  let debounce_timer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    const _m = parsed.miller
    const _layers = parsed.layers
    const _v = parsed.vacuum
    const _sc = parsed.supercell
    const _term = effective_termination
    const struct = upstream_structure

    if (debounce_timer) clearTimeout(debounce_timer)

    // When locked, skip regeneration — show the manually edited structure
    if (is_locked) {
      is_loading = false
      error_msg = null
      preview_structure = locked_structure
      return
    }

    if (!struct) {
      preview_structure = null
      error_msg = null
      is_loading = false
      // NOTE: Do NOT call onstructure_generated(null) here synchronously.
      // It would update parent `nodes`, re-trigger this effect, and cause
      // an infinite reactive loop (null !== undefined every iteration).
      return
    }

    is_loading = true
    error_msg = null
    const my_gen = ++gen_counter

    debounce_timer = setTimeout(async () => {
      try {
        const result = await wasm_generate_slab_layers(struct, _m, {
          num_layers: _layers,
          termination_index: _term,
          vacuum: _v,
          supercell: _sc,
        })
        if (gen_counter !== my_gen) return
        if (is_ok(result)) {
          const slab = postprocess_slab(result.ok)
          // Persist selective_dynamics onto the generated slab so the fixity
          // flows downstream (Adsorbate / geo_opt) — issue #222. The supercell
          // is already folded into the geometry, so freezing after generation
          // covers the tiled cell. Falls back to the raw slab if no freeze.
          const slab_json = JSON.stringify(slab)
          const frozen_json = apply_freeze_to_structure(slab_json, node_params) ?? slab_json
          preview_structure = JSON.parse(frozen_json)
          error_msg = null
          onstructure_generated?.(frozen_json)
        } else {
          preview_structure = null
          error_msg = result.error
          onstructure_generated?.(null)
        }
      } catch (err) {
        if (gen_counter !== my_gen) return
        preview_structure = null
        error_msg = err instanceof Error ? err.message : String(err)
        onstructure_generated?.(null)
      } finally {
        if (gen_counter === my_gen) is_loading = false
      }
    }, 300)
  })

  function select_termination(idx: number) {
    onparam_update?.(`termination`, idx)
  }
</script>

<div class="slab-preview">
  <!-- Termination selector (only when multiple terminations exist) -->
  {#if terminations.length > 1}
    <div class="termination-bar">
      <span class="term-label">{t(`workflow.termination`)}</span>
      <div class="term-options">
        {#each terminations as term, idx}
          <button
            class="term-btn"
            class:active={idx === effective_termination}
            onclick={() => select_termination(idx)}
            title={term.elements.join(', ')}
          >
            T{idx + 1}: {term.elements.join('-')}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- 3D viewport -->
  <div class="preview-viewport">
    {#if !upstream_structure}
      <div class="preview-msg">
        <span class="msg-icon">&#x1F517;</span>
        <span>{t(`workflow.calc_connect_structure_input`)}</span>
      </div>
    {:else if is_loading}
      <div class="preview-msg">
        <div class="spinner"></div>
        <span>{t(`workflow.generating`)}</span>
      </div>
    {:else if error_msg}
      <div class="preview-msg error">
        <span class="msg-icon">&#x26A0;</span>
        <span>{error_msg}</span>
      </div>
    {:else if preview_structure}
      <StructurePreview structure={preview_structure} />
      {#if on_expand}
        <button class="viewport-expand-btn" onclick={on_expand} title={t(`workflow.calc_open_full_viewer`)}>&#x26F6;</button>
      {/if}
    {/if}
  </div>

  <!-- Info bar -->
  {#if preview_structure && !is_loading}
    <div class="preview-info">
      <span>({parsed.miller.join('')}) &middot; {t(`workflow.atom_count_plain`, { n: preview_structure.sites?.length ?? 0 })}</span>
      {#if is_locked}
        <button class="unlock-btn" onclick={unlock} title={t(`workflow.unlock_auto_slab_generation`)}>{t(`workflow.edited_unlock`)}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .slab-preview {
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    overflow: hidden;
    margin: 4px 12px 8px;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }

  .termination-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    font-size: 10px;
  }
  .term-label {
    color: var(--text-color-dim, light-dark(#9ca3af, #999));
    white-space: nowrap;
  }
  .term-options {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }
  .term-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 10px;
    line-height: 1.4;
    transition: all 0.15s;
  }
  .term-btn:hover {
    border-color: var(--accent-color, light-dark(#4f46e5, #4fc3f7));
    color: var(--text-color, light-dark(#1f2937, #e5e7eb));
  }
  .term-btn.active {
    background: color-mix(in srgb, var(--accent-color, light-dark(#4f46e5, #4fc3f7)) 20%, transparent);
    border-color: var(--accent-color, light-dark(#4f46e5, #4fc3f7));
    color: var(--accent-color, light-dark(#4f46e5, #4fc3f7));
  }

  .preview-viewport {
    height: 220px;
    position: relative;
    background: #111;
    overflow: visible;
  }
  .preview-viewport :global(.structure-canvas-container) {
    overflow: visible !important;
  }
  .viewport-expand-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 10;
    background: rgba(0,0,0,0.5);
    border: 1px solid rgba(255,255,255,0.2);
    color: #ccc;
    cursor: pointer;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 14px;
    line-height: 1;
    transition: all 0.15s;
  }
  .viewport-expand-btn:hover {
    background: rgba(0,0,0,0.8);
    border-color: var(--accent-color, #4fc3f7);
    color: #fff;
  }

  .preview-msg {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: #888;
    font-size: 0.8rem;
  }
  .preview-msg.error { color: #e57373; }
  .msg-icon { font-size: 1.5rem; }

  .spinner {
    width: 20px; height: 20px;
    border: 2px solid #555;
    border-top-color: var(--accent-color, light-dark(#4f46e5, #4fc3f7));
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .preview-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #999));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
  }

  .unlock-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--accent-color, light-dark(#4f46e5, #4fc3f7));
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 9px;
    line-height: 1.4;
    transition: all 0.15s;
  }
  .unlock-btn:hover {
    background: color-mix(in srgb, var(--accent-color, light-dark(#4f46e5, #4fc3f7)) 15%, transparent);
    border-color: var(--accent-color, light-dark(#4f46e5, #4fc3f7));
  }

  .expand-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 0.8rem;
    line-height: 1;
  }
  .expand-btn:hover {
    background: color-mix(in srgb, var(--accent-color, light-dark(#4f46e5, #4fc3f7)) 20%, transparent);
    border-color: var(--accent-color, light-dark(#4f46e5, #4fc3f7));
  }
</style>
