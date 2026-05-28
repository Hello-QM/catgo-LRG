<script lang="ts">
  import { untrack } from "svelte";
  import { Spinner } from "$lib";
  import { API_BASE } from "$lib/api/config";
  import {
    register_analysis_session,
    unregister_analysis_session,
    store_session_blob,
  } from "$lib/chat/analysis-session-store.svelte";
  import FileSourceDialog from "$lib/electronic/FileSourceDialog.svelte";
  import MdRdfPanel from "./MdRdfPanel.svelte";
  import MdDynamicsPanel from "./MdDynamicsPanel.svelte";
  import MdDensityPanel from "./MdDensityPanel.svelte";
  import MdHbondsPanel from "./MdHbondsPanel.svelte";
  import MdClusteringPanel from "./MdClusteringPanel.svelte";
  import MdMsdPanel from "./MdMsdPanel.svelte";
  import MdOrientationPanel from "./MdOrientationPanel.svelte";
  import MdCavitationPanel from "./MdCavitationPanel.svelte";
  import { t, load_i18n_module } from "$lib/i18n/index.svelte";

  load_i18n_module("common");
  load_i18n_module("structure");

  type MdSubTab =
    | `rdf`
    | `dynamics`
    | `density`
    | `hbonds`
    | `clustering`
    | `msd`
    | `orientation`
    | `cavitation`;

  const sub_tabs: { id: MdSubTab; label_key: string }[] = [
    { id: `rdf`, label_key: `structure.md_tab_rdf` },
    { id: `dynamics`, label_key: `structure.md_tab_dynamics` },
    { id: `density`, label_key: `structure.md_tab_density` },
    { id: `hbonds`, label_key: `structure.md_tab_hbonds` },
    { id: `msd`, label_key: `structure.md_tab_msd` },
    { id: `orientation`, label_key: `structure.md_tab_orientation` },
    { id: `cavitation`, label_key: `structure.md_tab_cavitation` },
    { id: `clustering`, label_key: `structure.md_tab_clustering` },
  ];

  let {
    trajectory_b64 = ``,
    trajectory_format = ``,
    topology_b64 = null,
    topology_format = ``,
    on_plot = (data: any) => {},
  }: {
    trajectory_b64?: string;
    trajectory_format?: string;
    topology_b64?: string | null;
    topology_format?: string;
    on_plot?: (
      data: {
        traces: any[];
        title: string;
        x_label: string;
        y_label: string;
        layout_overrides?: Record<string, any>;
      } | null,
    ) => void;
  } = $props();

  let active_sub_tab: MdSubTab = $state(`rdf`);
  let error_msg: string = $state(``);

  // File import state
  let show_file_dialog = $state(false);
  let local_traj_b64 = $state(``);
  let local_traj_format = $state(``);
  let importing = $state(false);

  // Effective trajectory: local import takes priority over prop
  let effective_traj_b64 = $derived(local_traj_b64 || trajectory_b64);
  let effective_traj_format = $derived(local_traj_format || trajectory_format);
  let has_trajectory = $derived(!!effective_traj_b64);

  // Register/unregister MD session with analysis store for AI tool access.
  // Heavy trajectory data goes to non-reactive blob store (avoids Svelte proxy overhead).
  // Must untrack register/unregister — they read+write analysis_sessions ($state array).
  $effect(() => {
    if (effective_traj_b64) {
      const fmt = effective_traj_format;
      const topo_b64 = topology_b64;
      const topo_fmt = topology_format;
      const traj_b64 = effective_traj_b64;
      untrack(() => {
        const sid = `md-${Date.now()}`;
        store_session_blob(sid, {
          trajectory_b64: traj_b64,
          trajectory_format: fmt,
          topology_b64: topo_b64,
          topology_format: topo_fmt,
        });
        register_analysis_session({
          type: "md",
          session_id: sid,
          label: t("structure.md_trajectory_label", { format: fmt }),
          meta: { format: fmt },
          created_at: Date.now(),
        });
      });
    } else {
      untrack(() => unregister_analysis_session("md"));
    }
    return () => untrack(() => unregister_analysis_session("md"));
  });

  function file_to_b64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const arr = new Uint8Array(reader.result as ArrayBuffer);
        let binary = ``;
        for (let i = 0; i < arr.length; i++)
          binary += String.fromCharCode(arr[i]);
        resolve(btoa(binary));
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  async function handle_local_file(file: File) {
    importing = true;
    error_msg = ``;
    try {
      local_traj_b64 = await file_to_b64(file);
      local_traj_format = file.name.split(`.`).pop()?.toLowerCase() || ``;
    } catch (e: any) {
      error_msg = e.message || t("structure.failed_read_file");
    } finally {
      importing = false;
    }
  }

  async function handle_remote_trajectory(session_id: string, path: string) {
    importing = true;
    error_msg = ``;
    try {
      const resp = await fetch(
        `${API_BASE}/hpc/download?session_id=${encodeURIComponent(session_id)}&remote_path=${encodeURIComponent(path)}`,
      );
      if (!resp.ok) throw new Error(t("structure.download_failed_status", { status: resp.statusText }));
      const blob = await resp.blob();
      const arr = new Uint8Array(await blob.arrayBuffer());
      let binary = ``;
      for (let i = 0; i < arr.length; i++)
        binary += String.fromCharCode(arr[i]);
      local_traj_b64 = btoa(binary);
      local_traj_format = path.split(`.`).pop()?.toLowerCase() || ``;
    } catch (e: any) {
      error_msg = e.message || t("common.download_failed");
    } finally {
      importing = false;
    }
  }
</script>

<div class="md-analysis">
  {#if !has_trajectory}
    <div class="no-traj-hint">
      <p>{t("structure.import_trajectory_hint")}</p>
      <button class="import-btn" onclick={() => (show_file_dialog = true)}>
        {#if importing}<Spinner />{:else}{t("structure.import_trajectory")}{/if}
      </button>
    </div>
  {:else}
    <!-- Header with replace button -->
    <div class="md-header">
      <div class="tab-bar">
        {#each sub_tabs as tab}
          <button
            class="tab-btn"
            class:active={active_sub_tab === tab.id}
            onclick={() => (active_sub_tab = tab.id)}>{t(tab.label_key)}</button
          >
        {/each}
      </div>
      <button
        class="replace-btn"
        onclick={() => (show_file_dialog = true)}
        title={t("structure.import_different_trajectory")}
      >
        {t("structure.replace")}
      </button>
    </div>

    <!-- Tab content -->
    <div class="tab-content">
      {#if active_sub_tab === `rdf`}
        <MdRdfPanel
          trajectory_b64={effective_traj_b64}
          trajectory_format={effective_traj_format}
          {topology_b64}
          {topology_format}
          {on_plot}
        />
      {:else if active_sub_tab === `dynamics`}
        <MdDynamicsPanel
          trajectory_b64={effective_traj_b64}
          trajectory_format={effective_traj_format}
          {topology_b64}
          {topology_format}
          {on_plot}
        />
      {:else if active_sub_tab === `density`}
        <MdDensityPanel
          trajectory_b64={effective_traj_b64}
          trajectory_format={effective_traj_format}
          {topology_b64}
          {topology_format}
          {on_plot}
        />
      {:else if active_sub_tab === `hbonds`}
        <MdHbondsPanel
          trajectory_b64={effective_traj_b64}
          trajectory_format={effective_traj_format}
          {topology_b64}
          {topology_format}
          {on_plot}
        />
      {:else if active_sub_tab === `msd`}
        <MdMsdPanel
          trajectory_b64={effective_traj_b64}
          trajectory_format={effective_traj_format}
          {topology_b64}
          {topology_format}
          {on_plot}
        />
      {:else if active_sub_tab === `orientation`}
        <MdOrientationPanel
          trajectory_b64={effective_traj_b64}
          trajectory_format={effective_traj_format}
          {topology_b64}
          {topology_format}
          {on_plot}
        />
      {:else if active_sub_tab === `cavitation`}
        <MdCavitationPanel
          trajectory_b64={effective_traj_b64}
          trajectory_format={effective_traj_format}
          {topology_b64}
          {topology_format}
          {on_plot}
        />
      {:else if active_sub_tab === `clustering`}
        <MdClusteringPanel
          trajectory_b64={effective_traj_b64}
          trajectory_format={effective_traj_format}
          {topology_b64}
          {topology_format}
          {on_plot}
        />
      {/if}
    </div>
  {/if}

  {#if error_msg}
    <div class="error-msg">{error_msg}</div>
  {/if}
</div>

<FileSourceDialog
  bind:show={show_file_dialog}
  file_types={[
    `.xyz`,
    `.extxyz`,
    `.pdb`,
    `.gro`,
    `.traj`,
    `.xtc`,
    `.trr`,
    `.dcd`,
    `.lammpstrj`,
    `.nc`,
  ]}
  title={t("structure.load_trajectory")}
  description={t("structure.select_trajectory_md")}
  onfile={handle_local_file}
  onremote_path={handle_remote_trajectory}
  onclose={() => (show_file_dialog = false)}
/>

<style>
  .md-analysis {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.82em;
  }

  /* No trajectory hint */
  .no-traj-hint {
    padding: 24px 16px;
    text-align: center;
    color: var(--text-color-dim);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .no-traj-hint p {
    margin: 0;
  }
  .import-btn {
    padding: 6px 16px;
    background: var(--accent-color);
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .import-btn:hover {
    opacity: 0.85;
  }

  /* Header with tabs + replace button */
  .md-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .replace-btn {
    margin-left: auto;
    padding: 1px 8px;
    background: var(--pane-btn-bg);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    color: var(--text-color-dim);
    cursor: pointer;
    font-size: 0.8em;
    white-space: nowrap;
  }
  .replace-btn:hover {
    background: var(--pane-btn-bg-hover);
    color: var(--text-color);
  }

  /* Tab bar */
  .tab-bar {
    display: flex;
    gap: 2px;
    margin: 6px 0 4px;
  }
  .tab-btn {
    padding: 2px 10px;
    background: var(--pane-tabs-bg);
    border: var(--pane-border);
    border-radius: 3px 3px 0 0;
    color: var(--text-color-dim);
    cursor: pointer;
    font-size: 0.85em;
  }
  .tab-btn.active {
    background: var(--pane-bg);
    color: var(--text-color);
    border-bottom-color: transparent;
  }

  /* Tab content */
  .tab-content {
    flex: 1;
    min-height: 0;
  }

  /* Error message */
  .error-msg {
    padding: 5px 8px;
    background: color-mix(in srgb, var(--error-color) 15%, transparent);
    border: var(--error-border);
    border-radius: 4px;
    color: var(--error-color);
    font-size: 0.85em;
  }
</style>
