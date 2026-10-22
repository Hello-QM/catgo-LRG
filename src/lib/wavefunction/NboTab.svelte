<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { load_nbo, type NboResult } from './api'

  load_i18n_module('structure')

  let {
    nbo = $bindable(null),
    on_charges,
  }: {
    nbo?: NboResult | null
    /** Colour atoms by natural charge (one value per atom, in order) */
    on_charges: (charges: number[]) => void
  } = $props()

  let section = $state<`charges` | `bonds` | `e2`>(`charges`)
  let e2_min = $state(1.0)
  let error = $state(``)
  let loading = $state(false)

  let e2_rows = $derived(nbo ? nbo.e2.filter((e) => e.e2 >= e2_min) : [])

  async function on_file(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ``
    if (!file) return
    loading = true
    error = ``
    try {
      nbo = await load_nbo(await file.text(), file.name)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  function symbol(n: number) {
    const c = nbo?.charges.find((q) => q.atom === n)
    return c ? `${c.symbol}${n}` : String(n)
  }
</script>

<div class="wfa-tab">
  <p class="wfa-hint">{t('structure.wfa_nbo_hint')}</p>
  <label class="wfa-file">
    <input type="file" accept=".log,.out,.txt" onchange={on_file} />
    {loading ? t('structure.wfa_running') : t('structure.wfa_nbo_load')}
  </label>
  {#if error}<div class="wfa-error">{error}</div>{/if}

  {#if nbo}
    <div class="wfa-sections" role="tablist">
      <button role="tab" class:active={section === `charges`} aria-selected={section === `charges`}
        onclick={() => (section = `charges`)} disabled={nbo.charges.length === 0}>
        {t('structure.wfa_nbo_charges')}
      </button>
      <button role="tab" class:active={section === `bonds`} aria-selected={section === `bonds`}
        onclick={() => (section = `bonds`)} disabled={nbo.bonds.length === 0}>
        {t('structure.wfa_nbo_wiberg')}
      </button>
      <button role="tab" class:active={section === `e2`} aria-selected={section === `e2`}
        onclick={() => (section = `e2`)} disabled={nbo.e2.length === 0}>
        E(2)
      </button>
    </div>

    {#if section === `charges` && nbo.charges.length > 0}
      <button class="wfa-link" onclick={() => on_charges(nbo!.charges.map((c) => c.charge))}>
        {t('structure.wfa_nbo_color_atoms')}
      </button>
      <div class="wfa-table">
        <table>
          <thead><tr><th></th><th class="num">q</th><th class="num">{t('structure.wfa_nbo_valence')}</th><th class="num">Rydberg</th></tr></thead>
          <tbody>
            {#each nbo.charges as c (c.atom)}
              <tr>
                <td>{c.symbol}{c.atom}</td>
                <td class="num">{c.charge.toFixed(4)}</td>
                <td class="num">{c.valence.toFixed(4)}</td>
                <td class="num">{c.rydberg.toFixed(4)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if section === `bonds`}
      <div class="wfa-table">
        <table>
          <thead><tr><th></th><th class="num">WBI</th></tr></thead>
          <tbody>
            {#each nbo.bonds as b}
              <tr><td>{symbol(b.atoms[0])}–{symbol(b.atoms[1])}</td><td class="num">{b.wbi.toFixed(4)}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if section === `e2`}
      <label class="wfa-inline">
        E(2) ≥ <input type="number" min="0" step="0.5" bind:value={e2_min} /> kcal/mol
        <span class="wfa-count">({e2_rows.length}/{nbo.n_e2})</span>
      </label>
      <div class="wfa-table">
        <table>
          <thead>
            <tr><th>{t('structure.wfa_nbo_donor')}</th><th>{t('structure.wfa_nbo_acceptor')}</th><th class="num">E(2)</th></tr>
          </thead>
          <tbody>
            {#each e2_rows as e}
              <tr title={`E(j)-E(i) = ${e.gap} a.u., F(i,j) = ${e.fock} a.u.${e.spin ? `, ${e.spin}` : ``}`}>
                <td>{e.donor}</td><td>{e.acceptor}</td><td class="num">{e.e2.toFixed(2)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style>
  .wfa-tab { display: flex; flex-direction: column; gap: 6px; }
  .wfa-hint { margin: 0; font-size: 11px; color: var(--text-color-muted, #94a3b8); line-height: 1.4; }
  .wfa-file { font-size: 11px; color: var(--accent-color, #3b82f6); cursor: pointer; }
  .wfa-file input { display: none; }
  .wfa-error { color: #ef4444; font-size: 11px; white-space: pre-wrap; }
  .wfa-sections { display: flex; gap: 4px; }
  .wfa-sections button {
    flex: 1; padding: 3px 0; font-size: 11px; cursor: pointer; border-radius: 4px; font-family: inherit; color: inherit; background: transparent;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .wfa-sections button.active { background: var(--accent-color, #3b82f6); border-color: var(--accent-color, #3b82f6); color: #fff; }
  .wfa-sections button:disabled { opacity: 0.4; cursor: default; }
  .wfa-link { align-self: flex-start; background: none; border: none; padding: 0; color: var(--accent-color, #3b82f6); cursor: pointer; font-size: 11px; font-family: inherit; }
  .wfa-inline { font-size: 11px; display: flex; align-items: center; gap: 4px; }
  .wfa-inline input { width: 4em; padding: 2px 4px; font-size: 11px; color: inherit; background: transparent; border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 3px; }
  .wfa-count { color: var(--text-color-dim, #999); }
  .wfa-table { max-height: 16em; overflow-y: auto; border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040)); border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { position: sticky; top: 0; background: var(--surface-bg, light-dark(#fff, #1e1e1e)); font-size: 9px; color: var(--text-color-dim, #999); padding: 3px 5px; text-align: left; text-transform: uppercase; }
  td { padding: 2px 5px; }
  .num { text-align: right; font-family: 'SF Mono', 'Cascadia Code', monospace; }
</style>
