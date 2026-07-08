<script lang="ts">
  import type { ProjectDetail } from '$lib/api/project'
  import type { StepInfo } from './workflow-types'
  import * as workflow_api from '$lib/api/workflow'
  import { download } from '$lib/io/fetch'

  let {
    project,
  }: {
    project: ProjectDetail | null
  } = $props()

  const KCAL_PER_MOL_TO_EV = 0.043364

  // Kreitz 2021 RPBE-D3 reference values. Stored as a plain record so users
  // can read the source and override — the column is advisory, not a gate.
  const KREITZ_2021 = {
    gamma_111: { value: 2.011, unit: `J/m²`, note: `RPBE-D3 Ni(111)` },
    gamma_100: { value: 2.226, unit: `J/m²`, note: `RPBE-D3 Ni(100)` },
    gamma_110: { value: 2.153, unit: `J/m²`, note: `RPBE-D3 Ni(110)` },
    gamma_211: { value: 2.246, unit: `J/m²`, note: `RPBE-D3 Ni(211)` },
    wulff_111: { value: 0.85, unit: `fraction`, note: `Dominant (111)` },
    wulff_100: { value: 0.12, unit: `fraction`, note: `` },
    e_ads_h: { value: -0.46, unit: `eV`, note: `H @ FCC hollow, ZPE-corr` },
    cov_slope: { value: 0.08, unit: `eV/ML`, note: `Mild repulsion slope` },
    neb_barrier: { value: 2.88, unit: `eV`, note: `CO* → C*+O* forward` },
    ts_freq: { value: -412, unit: `cm⁻¹`, note: `TS imaginary mode` },
  }

  interface Row {
    key: string
    label: string
    unit: string
    catgo: number | null
    kreitz: number | null
    note: string
  }

  let rows = $state<Row[]>([])
  let metadata = $state<Record<string, unknown> | null>(null)
  let loading = $state(false)
  let error = $state(``)
  let workflow_count = $state(0)

  function safe_parse(s: string | undefined | null): Record<string, unknown> | null {
    if (!s) return null
    try {
      const parsed = JSON.parse(s)
      return typeof parsed === `object` && parsed !== null ? parsed : null
    } catch {
      return null
    }
  }

  function fmt(v: number | null, digits = 3): string {
    if (v == null || Number.isNaN(v)) return `—`
    return v.toFixed(digits)
  }

  function fmt_delta(catgo: number | null, ref: number | null): string {
    if (catgo == null || ref == null) return `—`
    const d = catgo - ref
    const sign = d >= 0 ? `+` : ``
    return `${sign}${d.toFixed(3)}`
  }

  async function load() {
    if (!project?.workflows?.length) {
      rows = []
      metadata = null
      workflow_count = 0
      return
    }
    loading = true
    error = ``
    try {
      const all_steps: StepInfo[] = []
      for (const wf of project.workflows) {
        try {
          const steps = await workflow_api.list_steps_http(wf.id)
          all_steps.push(...steps)
        } catch (e) {
          console.warn(`[BenchmarkTable] Failed to fetch steps for ${wf.id}:`, e)
        }
      }
      workflow_count = project.workflows.length
      rows = build_rows(all_steps)
      metadata = pick_latest_metadata(all_steps)
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  // Only reload when the SET of workflow IDs changes — not on every
  // mutation of project.workflows (ProjectDashboard rewrites the array
  // every 30s via update_live_steps even when IDs are unchanged, which
  // would otherwise retrigger load() and hit the backend N times per
  // poll cycle). Depending on a stable string derived from sorted IDs
  // lets Svelte's batching skip no-op effect runs.
  const workflow_id_key = $derived(
    (project?.workflows ?? []).map((w) => w.id).sort().join(`,`),
  )

  $effect(() => {
    // Read the stable key so Svelte tracks it as the effect's dependency.
    void workflow_id_key
    if (project?.workflows) load()
  })

  function build_rows(steps: StepInfo[]): Row[] {
    const out: Row[] = []

    // 1) Surface energies γ(hkl) — prefer per_facet map from the
    //    `surface_energy` analysis node. Fall back to single-facet top-level.
    const surf_step = latest_completed(steps, `surface_energy`)
    const surf = safe_parse(surf_step?.result_json)
    const per_facet = (surf?.per_facet ?? null) as Record<string, { gamma_J_per_m2?: number }> | null
    for (const hkl of [`111`, `100`, `110`, `211`] as const) {
      const gamma = per_facet?.[hkl]?.gamma_J_per_m2 ?? null
      const kref = KREITZ_2021[`gamma_${hkl}` as const]
      out.push({
        key: `gamma_${hkl}`,
        label: `γ(${hkl[0]}${hkl[1]}${hkl[2]})`,
        unit: `J/m²`,
        catgo: typeof gamma === `number` ? gamma : null,
        kreitz: kref.value,
        note: kref.note,
      })
    }

    // 2) Wulff facet fractions — from `wulff_construction` node.
    const wulff_step = latest_completed(steps, `wulff_construction`)
    const wulff = safe_parse(wulff_step?.result_json)
    const area_fractions = (wulff?.area_fractions ?? null) as Record<string, number> | null
    for (const hkl of [`111`, `100`] as const) {
      const frac = area_fractions?.[hkl] ?? null
      const kref = KREITZ_2021[`wulff_${hkl}` as const]
      out.push({
        key: `wulff_${hkl}`,
        label: `Wulff fraction (${hkl[0]}${hkl[1]}${hkl[2]})`,
        unit: `fraction`,
        catgo: typeof frac === `number` ? frac : null,
        kreitz: kref.value,
        note: kref.note,
      })
    }

    // 3) H adsorption energy (ZPE-corrected preferred).
    const ads_step = latest_completed(steps, `adsorption_energy`)
    const ads = safe_parse(ads_step?.result_json)
    const e_ads = (ads?.E_ads_ZPE_eV ?? ads?.E_ads_eV ?? null) as number | null
    out.push({
      key: `e_ads_h`,
      label: `E_ads(H) ${ads?.E_ads_ZPE_eV != null ? `[ZPE-corr]` : `[electronic]`}`,
      unit: `eV`,
      catgo: typeof e_ads === `number` ? e_ads : null,
      kreitz: KREITZ_2021.e_ads_h.value,
      note: KREITZ_2021.e_ads_h.note,
    })

    // 4) Coverage slope ∂E_ads/∂θ — from `coverage_analysis`.
    const cov_step = latest_completed(steps, `coverage_analysis`)
    const cov = safe_parse(cov_step?.result_json)
    const slope = ((cov?.fit as { slope?: number } | undefined)?.slope ?? null) as number | null
    out.push({
      key: `cov_slope`,
      label: `∂E_ads/∂θ`,
      unit: `eV/ML`,
      catgo: typeof slope === `number` ? slope : null,
      kreitz: KREITZ_2021.cov_slope.value,
      note: KREITZ_2021.cov_slope.note,
    })

    // 5) NEB barrier — from ts_search (mlp_neb). Convert kcal/mol → eV.
    const neb_step = latest_completed(steps, `ts_search`) ?? latest_completed(steps, `mlp_neb`)
    const neb = safe_parse(neb_step?.result_json)
    const barrier_kcal = (neb?.activation_barrier_kcal_mol ?? null) as number | null
    const barrier_ev = typeof barrier_kcal === `number` ? barrier_kcal * KCAL_PER_MOL_TO_EV : null
    out.push({
      key: `neb_barrier`,
      label: `NEB barrier (CO*→C*+O*)`,
      unit: `eV`,
      catgo: barrier_ev,
      kreitz: KREITZ_2021.neb_barrier.value,
      note: KREITZ_2021.neb_barrier.note,
    })

    // 6) TS imaginary-mode frequency — from the freq step at the TS.
    //    When the preset runs, the TS-freq node is the freq node that follows
    //    the ts_search node. We pick the freq step that reports is_valid_ts
    //    and the most-negative dominant_imag_freq_cm.
    const freq_step = pick_ts_freq(steps)
    const freq = safe_parse(freq_step?.result_json)
    const imag = (freq?.dominant_imag_freq_cm ?? null) as number | null
    out.push({
      key: `ts_freq`,
      label: `ν_imag @ TS`,
      unit: `cm⁻¹`,
      catgo: typeof imag === `number` ? imag : null,
      kreitz: KREITZ_2021.ts_freq.value,
      note: KREITZ_2021.ts_freq.note,
    })

    return out
  }

  function latest_completed(steps: StepInfo[], node_type: string): StepInfo | undefined {
    const matches = steps.filter(
      (s) => s.node_type === node_type && s.status === `completed` && s.result_json,
    )
    if (matches.length === 0) return undefined
    // Prefer the most recently completed one.
    return matches.sort((a, b) => (b.completed_at ?? ``).localeCompare(a.completed_at ?? ``))[0]
  }

  function pick_ts_freq(steps: StepInfo[]): StepInfo | undefined {
    // Only accept freq steps that look like a real TS. Two gates:
    //   - is_valid_ts === true (C2 engine flag: exactly one imag mode with
    //     |freq| >= 20 cm⁻¹), OR
    //   - |dominant_imag_freq_cm| >= 100 cm⁻¹ as a conservative fallback
    //     for result_json written before C2 shipped.
    // Without this, an adsorbate-minimum freq step with a spurious noise
    // mode around -25 cm⁻¹ would get picked and silently reported as the
    // TS frequency — see silent-failure audit finding #3.
    const freq_steps = steps.filter(
      (s) => [`freq`, `mlp_vibrations`].includes(s.node_type) && s.status === `completed` && s.result_json,
    )
    const candidates = freq_steps
      .map((s) => ({ step: s, data: safe_parse(s.result_json) }))
      .filter((x) => x.data && typeof x.data.dominant_imag_freq_cm === `number`)
    if (candidates.length === 0) return undefined
    const ts_like = candidates.filter((c) => {
      const freq = c.data?.dominant_imag_freq_cm as number
      return c.data?.is_valid_ts === true || Math.abs(freq) >= 100
    })
    if (ts_like.length === 0) return undefined
    // Most-negative (largest-magnitude imaginary) wins — that's the TS mode.
    ts_like.sort(
      (a, b) => (a.data?.dominant_imag_freq_cm as number) - (b.data?.dominant_imag_freq_cm as number),
    )
    return ts_like[0].step
  }

  function pick_latest_metadata(steps: StepInfo[]): Record<string, unknown> | null {
    // Reproducibility metadata is attached to every MLP result via the C1 footer.
    const mlp_steps = steps
      .filter((s) => s.result_json && s.status === `completed`)
      .map((s) => ({ step: s, data: safe_parse(s.result_json) }))
      .filter((x) => x.data?.metadata && typeof x.data.metadata === `object`)
    if (mlp_steps.length === 0) return null
    mlp_steps.sort((a, b) => (b.step.completed_at ?? ``).localeCompare(a.step.completed_at ?? ``))
    return mlp_steps[0].data?.metadata as Record<string, unknown>
  }

  // RFC 4180: a CSV field containing ", newline, or , must be quoted, and
  // any internal " must be doubled. Metadata values (model paths, host,
  // timestamps with fractional seconds) may contain any of these, so all
  // string cells go through this helper.
  function csv_quote(s: unknown): string {
    const str = String(s ?? ``)
    return `"${str.replaceAll(`"`, `""`)}"`
  }

  function export_csv() {
    const header = [`Quantity`, `CatGo (MACE)`, `Kreitz 2021`, `Δ (MACE − Kreitz)`, `Unit`, `Note`]
    const lines = [header.map(csv_quote).join(`,`)]
    for (const r of rows) {
      lines.push(
        [
          csv_quote(r.label),
          r.catgo == null ? `` : r.catgo.toFixed(6),
          r.kreitz == null ? `` : r.kreitz.toFixed(6),
          r.catgo != null && r.kreitz != null ? (r.catgo - r.kreitz).toFixed(6) : ``,
          csv_quote(r.unit),
          csv_quote(r.note),
        ].join(`,`),
      )
    }
    if (metadata) {
      lines.push(``)
      lines.push(csv_quote(`# Reproducibility (metadata below, not part of the table)`))
      for (const [k, v] of Object.entries(metadata)) {
        lines.push([csv_quote(`# ${k}`), csv_quote(typeof v === `string` ? v : JSON.stringify(v))].join(`,`))
      }
    }
    download(lines.join(`\n`), `mace-ni-benchmark.csv`, `text/csv`)
  }
</script>

<div class="bench">
  <div class="header-row">
    <h3>MACE Ni Benchmark — Kreitz 2021 Comparison</h3>
    <div class="header-actions">
      <button class="refresh-btn" onclick={load} disabled={loading}>
        {loading ? `Refreshing…` : `Refresh`}
      </button>
      <button class="csv-btn" onclick={export_csv} disabled={rows.length === 0}>
        Export CSV
      </button>
    </div>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading && rows.length === 0}
    <div class="empty">Loading benchmark results…</div>
  {:else if rows.length === 0}
    <div class="empty">
      No benchmark data yet. Run the "MACE Ni Benchmark (Kreitz 2021)" preset on this project.
    </div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Quantity</th>
          <th class="num">CatGo (MACE)</th>
          <th class="num">Kreitz 2021</th>
          <th class="num">Δ</th>
          <th>Unit</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.key)}
          <tr class:missing={r.catgo == null}>
            <td>{r.label}</td>
            <td class="num">{fmt(r.catgo, 3)}</td>
            <td class="num">{fmt(r.kreitz, 3)}</td>
            <td class="num delta">{fmt_delta(r.catgo, r.kreitz)}</td>
            <td>{r.unit}</td>
            <td class="note">{r.note}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div class="subtitle">
      Scanned {workflow_count} workflow{workflow_count === 1 ? `` : `s`} in this project.
      Reference column is RPBE-D3 from <a
        href="https://doi.org/10.1021/acscatal.1c02988"
        target="_blank"
        rel="noopener"
      >Kreitz et al. 2021</a>.
      MACE-MP-0 deviation of ~0.1–0.3 (J/m² or eV) is expected.
    </div>

    {#if metadata}
      <div class="meta-box">
        <div class="meta-title">Reproducibility metadata (latest MLP step)</div>
        <div class="meta-grid">
          {#each Object.entries(metadata) as [k, v] (k)}
            <div class="meta-k">{k}</div>
            <div class="meta-v">{typeof v === `string` ? v : JSON.stringify(v)}</div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .bench {
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--text-color, #eee);
  }
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .header-row h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
  }
  .header-actions { display: flex; gap: 8px; }
  .refresh-btn, .csv-btn {
    padding: 6px 12px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.25);
    border-radius: 6px;
    color: #60a5fa;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
  }
  .refresh-btn:hover, .csv-btn:hover { background: rgba(59, 130, 246, 0.2); }
  .refresh-btn:disabled, .csv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .error {
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #ef4444;
    font-size: 12px;
    margin-bottom: 12px;
  }
  .empty {
    text-align: center;
    color: var(--text-color-muted);
    padding: 32px;
    font-size: 13px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    overflow: hidden;
  }
  th, td {
    padding: 8px 12px;
    text-align: left;
    border-bottom: 1px solid var(--border-color);
    font-size: 12px;
  }
  th {
    background: var(--surface-bg-hover);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-color-muted);
  }
  tbody tr:last-child td { border-bottom: none; }
  tr.missing td { color: var(--text-color-muted); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.delta { color: #f59e0b; font-weight: 600; }
  tr.missing td.delta { color: var(--text-color-muted); font-weight: 400; }
  td.note { color: var(--text-color-muted); font-size: 11px; }
  .subtitle {
    margin-top: 10px;
    font-size: 11px;
    color: var(--text-color-muted);
    line-height: 1.5;
  }
  .subtitle a { color: #60a5fa; text-decoration: none; }
  .subtitle a:hover { text-decoration: underline; }
  .meta-box {
    margin-top: 16px;
    padding: 10px 12px;
    background: var(--surface-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }
  .meta-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-color-muted);
    margin-bottom: 6px;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    font-size: 11px;
  }
  .meta-k { color: var(--text-color-muted); }
  .meta-v {
    font-family: inherit;
    word-break: break-all;
    color: var(--text-color);
  }
</style>
