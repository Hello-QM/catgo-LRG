<script lang="ts">
  import { Spinner } from '$lib'
  import type {
    RMSDClusterRequest,
    RMSDClusterResponse,
    CVClusterRequest,
    CVClusterResponse,
    CVParams,
    DimReduceRequest,
    DimReduceResponse,
    DimReduceClusteringParams,
  } from './types'

  let {
    trajectory_b64,
    trajectory_format,
    topology_b64 = null,
    topology_format = ``,
    on_plot = (data: any) => {},
  }: {
    trajectory_b64: string
    trajectory_format: string
    topology_b64?: string | null
    topology_format?: string
    on_plot?: (data: { traces: any[]; title: string; x_label: string; y_label: string; layout_overrides?: Record<string, any> } | null) => void
  } = $props()

  const server_url = `http://localhost:8000`

  // =========================================================================
  // Shared helpers
  // =========================================================================

  const CLUSTER_COLORS = [
    `#1f77b4`, `#ff7f0e`, `#2ca02c`, `#d62728`, `#9467bd`,
    `#8c564b`, `#e377c2`, `#7f7f7f`, `#bcbd22`, `#17becf`,
  ]

  /** Parse a comma-separated list of integers from a text input. */
  function parse_int_list(text: string): number[] | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    const parts = trimmed.split(/[\s,]+/).filter(Boolean)
    const nums = parts.map((p) => parseInt(p, 10))
    if (nums.some(isNaN)) return null
    return nums
  }

  /** Parse semicolon-separated groups of comma-separated integers.
   *  e.g. "0,1 ; 2,3 ; 4,5" => [[0,1], [2,3], [4,5]]
   */
  function parse_int_groups(text: string, group_size: number): number[][] | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    const groups = trimmed.split(/\s*;\s*/).filter(Boolean)
    const result: number[][] = []
    for (const g of groups) {
      const nums = g.split(/[\s,]+/).filter(Boolean).map((p) => parseInt(p, 10))
      if (nums.length !== group_size || nums.some(isNaN)) return null
      result.push(nums)
    }
    return result.length > 0 ? result : null
  }

  /**
   * Build scatter traces from an embedding and optional cluster labels.
   * Returns traces and formatted axis labels.
   */
  function build_scatter_traces(
    embedding: number[][],
    labels: number[] | null,
    frame_indices: number[],
    method: string,
    explained_variance: number[] | null,
  ): { traces: any[]; x_label: string; y_label: string } {
    const method_upper = method.toUpperCase()

    let x_label: string
    let y_label: string
    if (explained_variance && explained_variance.length >= 2) {
      x_label = `${method_upper}1 (${(explained_variance[0] * 100).toFixed(1)}%)`
      y_label = `${method_upper}2 (${(explained_variance[1] * 100).toFixed(1)}%)`
    } else {
      x_label = `${method_upper} 1`
      y_label = `${method_upper} 2`
    }

    if (labels) {
      // One trace per cluster for legend
      const unique_labels = [...new Set(labels)].sort((a, b) => a - b)
      const traces = unique_labels.map((label, idx) => {
        const mask = labels
          .map((l, j) => (l === label ? j : -1))
          .filter((j) => j >= 0)
        return {
          x: mask.map((j) => embedding[j][0]),
          y: mask.map((j) => embedding[j][1]),
          type: `scatter` as const,
          mode: `markers` as const,
          name: label === -1 ? `Noise` : `Cluster ${label}`,
          marker: {
            color: label === -1 ? `#666` : CLUSTER_COLORS[idx % CLUSTER_COLORS.length],
            size: 6,
            opacity: label === -1 ? 0.4 : 0.7,
          },
          text: mask.map((j) => `Frame ${frame_indices[j]}, Cluster ${label === -1 ? `Noise` : label}`),
          hoverinfo: `text+name`,
        }
      })
      return { traces, x_label, y_label }
    } else {
      // Single trace, color by frame index (continuous)
      return {
        traces: [
          {
            x: embedding.map((p) => p[0]),
            y: embedding.map((p) => p[1]),
            type: `scatter` as const,
            mode: `markers` as const,
            marker: {
              color: frame_indices,
              colorscale: `Viridis`,
              size: 6,
              opacity: 0.7,
              colorbar: {
                title: `Frame`,
                titlefont: { color: `#ccc` },
                tickfont: { color: `#ccc` },
              },
            },
            text: frame_indices.map((i) => `Frame ${i}`),
            hoverinfo: `text`,
            showlegend: false,
          },
        ],
        x_label,
        y_label,
      }
    }
  }

  /** Build scatter3d traces for 3-component embeddings. */
  function build_scatter3d_traces(
    embedding: number[][],
    labels: number[] | null,
    frame_indices: number[],
    method: string,
    explained_variance: number[] | null,
  ): { traces: any[]; x_label: string; y_label: string; z_label: string } {
    const method_upper = method.toUpperCase()
    let x_label: string
    let y_label: string
    let z_label: string
    if (explained_variance && explained_variance.length >= 3) {
      x_label = `${method_upper}1 (${(explained_variance[0] * 100).toFixed(1)}%)`
      y_label = `${method_upper}2 (${(explained_variance[1] * 100).toFixed(1)}%)`
      z_label = `${method_upper}3 (${(explained_variance[2] * 100).toFixed(1)}%)`
    } else {
      x_label = `${method_upper} 1`
      y_label = `${method_upper} 2`
      z_label = `${method_upper} 3`
    }

    if (labels) {
      const unique_labels = [...new Set(labels)].sort((a, b) => a - b)
      const traces = unique_labels.map((label, idx) => {
        const mask = labels
          .map((l, j) => (l === label ? j : -1))
          .filter((j) => j >= 0)
        return {
          x: mask.map((j) => embedding[j][0]),
          y: mask.map((j) => embedding[j][1]),
          z: mask.map((j) => embedding[j][2]),
          type: `scatter3d` as const,
          mode: `markers` as const,
          name: label === -1 ? `Noise` : `Cluster ${label}`,
          marker: {
            color: label === -1 ? `#666` : CLUSTER_COLORS[idx % CLUSTER_COLORS.length],
            size: 3,
            opacity: label === -1 ? 0.4 : 0.7,
          },
          text: mask.map((j) => `Frame ${frame_indices[j]}, Cluster ${label === -1 ? `Noise` : label}`),
          hoverinfo: `text+name`,
        }
      })
      return { traces, x_label, y_label, z_label }
    } else {
      return {
        traces: [
          {
            x: embedding.map((p) => p[0]),
            y: embedding.map((p) => p[1]),
            z: embedding.map((p) => p[2]),
            type: `scatter3d` as const,
            mode: `markers` as const,
            marker: {
              color: frame_indices,
              colorscale: `Viridis`,
              size: 3,
              opacity: 0.7,
              colorbar: {
                title: `Frame`,
                titlefont: { color: `#ccc` },
                tickfont: { color: `#ccc` },
              },
            },
            text: frame_indices.map((i) => `Frame ${i}`),
            hoverinfo: `text`,
            showlegend: false,
          },
        ],
        x_label,
        y_label,
        z_label,
      }
    }
  }


  // =========================================================================
  // Section 1: RMSD-based Clustering
  // =========================================================================

  let rmsd_method = $state<`dbscan` | `kmeans` | `hierarchical`>(`dbscan`)
  let rmsd_eps = $state(2.0)
  let rmsd_min_samples = $state(5)
  let rmsd_n_clusters = $state(5)
  let rmsd_linkage = $state<`ward` | `average` | `complete`>(`average`)
  let rmsd_atom_indices_text = $state(``)
  let rmsd_stride = $state(1)
  let rmsd_computing = $state(false)
  let rmsd_error = $state(``)
  let rmsd_result = $state<RMSDClusterResponse | null>(null)

  async function run_rmsd_cluster() {
    rmsd_computing = true
    rmsd_error = ``
    rmsd_result = null

    try {
      const atom_indices = parse_int_list(rmsd_atom_indices_text)
      const body: RMSDClusterRequest = {
        trajectory_b64,
        format: trajectory_format,
        method: rmsd_method,
        atom_indices,
        stride: rmsd_stride > 1 ? rmsd_stride : undefined,
        eps: rmsd_eps,
        min_samples: rmsd_min_samples,
        n_clusters: rmsd_n_clusters,
        linkage: rmsd_linkage,
      }

      const resp = await fetch(`${server_url}/api/md/clustering/rmsd-cluster`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `Request failed (${resp.status})`)
      }

      rmsd_result = await resp.json()
    } catch (e: any) {
      rmsd_error = e.message || `RMSD clustering failed`
    } finally {
      rmsd_computing = false
    }
  }

  // Emit RMSD plot data when result changes
  $effect(() => {
    if (!rmsd_result) return
    const { traces, x_label, y_label } = build_scatter_traces(
      rmsd_result.pca_2d,
      rmsd_result.labels,
      rmsd_result.frame_indices,
      `PC`,
      rmsd_result.pca_explained_variance,
    )
    on_plot?.({ traces, title: `RMSD Clustering (PCA projection)`, x_label, y_label })
  })

  // =========================================================================
  // Section 2: CV-based Clustering
  // =========================================================================

  let cv_type = $state<`distances` | `angles` | `dihedrals` | `contacts` | `mixed`>(`distances`)
  let cv_pairs_text = $state(``)
  let cv_triplets_text = $state(``)
  let cv_quartets_text = $state(``)
  let cv_scheme = $state<`closest-heavy` | `ca`>(`closest-heavy`)
  let cv_cutoff = $state(4.5)
  // Mixed CV checkboxes
  let cv_mixed_distances = $state(false)
  let cv_mixed_angles = $state(false)
  let cv_mixed_dihedrals = $state(false)
  let cv_mixed_contacts = $state(false)

  let cv_cluster_method = $state<`dbscan` | `kmeans` | `hierarchical`>(`kmeans`)
  let cv_eps = $state(0.5)
  let cv_min_samples = $state(5)
  let cv_n_clusters = $state(5)
  let cv_linkage = $state<`ward` | `average` | `complete`>(`ward`)
  let cv_stride = $state(1)
  let cv_computing = $state(false)
  let cv_error = $state(``)
  let cv_result = $state<CVClusterResponse | null>(null)

  async function run_cv_cluster() {
    cv_computing = true
    cv_error = ``
    cv_result = null

    try {
      const cv_params: CVParams = {}

      if (cv_type === `distances` || (cv_type === `mixed` && cv_mixed_distances)) {
        const pairs = parse_int_groups(cv_pairs_text, 2)
        if (!pairs && (cv_type === `distances` || cv_mixed_distances)) {
          throw new Error(`Invalid atom pairs. Use format: 0,1 ; 2,3 ; ...`)
        }
        cv_params.atom_pairs = pairs
      }

      if (cv_type === `angles` || (cv_type === `mixed` && cv_mixed_angles)) {
        const triplets = parse_int_groups(cv_triplets_text, 3)
        if (!triplets && (cv_type === `angles` || cv_mixed_angles)) {
          throw new Error(`Invalid atom triplets. Use format: 0,1,2 ; 3,4,5 ; ...`)
        }
        cv_params.atom_triplets = triplets
      }

      if (cv_type === `dihedrals` || (cv_type === `mixed` && cv_mixed_dihedrals)) {
        const quartets = parse_int_groups(cv_quartets_text, 4)
        if (!quartets && (cv_type === `dihedrals` || cv_mixed_dihedrals)) {
          throw new Error(`Invalid atom quartets. Use format: 0,1,2,3 ; 4,5,6,7 ; ...`)
        }
        cv_params.atom_quartets = quartets
      }

      if (cv_type === `contacts` || (cv_type === `mixed` && cv_mixed_contacts)) {
        cv_params.scheme = cv_scheme
        cv_params.cutoff = cv_cutoff
      }

      const body: CVClusterRequest = {
        trajectory_b64,
        format: trajectory_format,
        cv_type,
        cv_params,
        clustering_method: cv_cluster_method,
        eps: cv_eps,
        min_samples: cv_min_samples,
        n_clusters: cv_n_clusters,
        linkage: cv_linkage,
        stride: cv_stride > 1 ? cv_stride : undefined,
      }

      const resp = await fetch(`${server_url}/api/md/clustering/cv-cluster`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `Request failed (${resp.status})`)
      }

      cv_result = await resp.json()
    } catch (e: any) {
      cv_error = e.message || `CV clustering failed`
    } finally {
      cv_computing = false
    }
  }

  // Emit CV plot data when result changes
  $effect(() => {
    if (!cv_result) return
    const { traces, x_label, y_label } = build_scatter_traces(
      cv_result.pca_2d,
      cv_result.labels,
      cv_result.frame_indices,
      `PC`,
      cv_result.pca_explained_variance,
    )
    on_plot?.({ traces, title: `CV Clustering (PCA projection)`, x_label, y_label })
  })

  // =========================================================================
  // Section 3: Dimensionality Reduction
  // =========================================================================

  let dr_feature_type = $state<`coordinates` | `rmsd_matrix` | `custom_cv`>(`rmsd_matrix`)
  let dr_method = $state<`pca` | `tsne` | `umap`>(`pca`)
  let dr_n_components = $state(2)

  // Custom CV sub-params (when feature_type = custom_cv)
  let dr_cv_type = $state<`distances` | `angles` | `dihedrals` | `contacts` | `mixed`>(`distances`)
  let dr_cv_pairs_text = $state(``)
  let dr_cv_triplets_text = $state(``)
  let dr_cv_quartets_text = $state(``)
  let dr_cv_scheme = $state<`closest-heavy` | `ca`>(`closest-heavy`)
  let dr_cv_cutoff = $state(4.5)

  // t-SNE params
  let dr_perplexity = $state(30)
  let dr_learning_rate = $state(200)

  // UMAP params
  let dr_n_neighbors = $state(15)
  let dr_min_dist = $state(0.1)

  // Atom indices / stride
  let dr_atom_indices_text = $state(``)
  let dr_stride = $state(1)

  // Optional clustering on embedding
  let dr_cluster_enabled = $state(false)
  let dr_cluster_method = $state<`dbscan` | `kmeans` | `hierarchical`>(`dbscan`)
  let dr_cluster_eps = $state(0.5)
  let dr_cluster_min_samples = $state(5)
  let dr_cluster_n_clusters = $state(5)
  let dr_cluster_linkage = $state<`ward` | `average` | `complete`>(`ward`)

  let dr_computing = $state(false)
  let dr_error = $state(``)
  let dr_result = $state<DimReduceResponse | null>(null)

  async function run_dimreduce() {
    dr_computing = true
    dr_error = ``
    dr_result = null

    try {
      const atom_indices = parse_int_list(dr_atom_indices_text)

      let cv_type_param: DimReduceRequest[`cv_type`] = undefined
      let cv_params_param: DimReduceRequest[`cv_params`] = undefined

      if (dr_feature_type === `custom_cv`) {
        cv_type_param = dr_cv_type
        const cv_params: CVParams = {}
        if (dr_cv_type === `distances` || dr_cv_type === `mixed`) {
          cv_params.atom_pairs = parse_int_groups(dr_cv_pairs_text, 2)
        }
        if (dr_cv_type === `angles` || dr_cv_type === `mixed`) {
          cv_params.atom_triplets = parse_int_groups(dr_cv_triplets_text, 3)
        }
        if (dr_cv_type === `dihedrals` || dr_cv_type === `mixed`) {
          cv_params.atom_quartets = parse_int_groups(dr_cv_quartets_text, 4)
        }
        if (dr_cv_type === `contacts` || dr_cv_type === `mixed`) {
          cv_params.scheme = dr_cv_scheme
          cv_params.cutoff = dr_cv_cutoff
        }
        cv_params_param = cv_params
      }

      let clustering: DimReduceClusteringParams | undefined = undefined
      if (dr_cluster_enabled) {
        clustering = {
          method: dr_cluster_method,
          eps: dr_cluster_eps,
          min_samples: dr_cluster_min_samples,
          n_clusters: dr_cluster_n_clusters,
          linkage: dr_cluster_linkage,
        }
      }

      const body: DimReduceRequest = {
        trajectory_b64,
        format: trajectory_format,
        method: dr_method,
        n_components: dr_n_components,
        feature_type: dr_feature_type,
        atom_indices,
        stride: dr_stride > 1 ? dr_stride : undefined,
        cv_type: cv_type_param,
        cv_params: cv_params_param,
        perplexity: dr_perplexity,
        learning_rate: dr_learning_rate,
        n_neighbors: dr_n_neighbors,
        min_dist: dr_min_dist,
        clustering: clustering ?? undefined,
      }

      const resp = await fetch(`${server_url}/api/md/clustering/dimreduce`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `Request failed (${resp.status})`)
      }

      dr_result = await resp.json()
    } catch (e: any) {
      dr_error = e.message || `Dimensionality reduction failed`
    } finally {
      dr_computing = false
    }
  }

  // Emit dimreduce plot data when result changes
  $effect(() => {
    if (!dr_result) return

    if (dr_n_components === 3 && dr_result.embedding[0]?.length === 3) {
      const { traces, x_label, y_label, z_label } = build_scatter3d_traces(
        dr_result.embedding,
        dr_result.labels ?? null,
        dr_result.frame_indices,
        dr_result.method,
        dr_result.explained_variance ?? null,
      )
      on_plot?.({
        traces,
        title: `Dimensionality Reduction (${dr_result.method.toUpperCase()} 3D)`,
        x_label,
        y_label,
        layout_overrides: {
          scene: {
            xaxis: { title: x_label },
            yaxis: { title: y_label },
            zaxis: { title: z_label },
          },
        },
      })
    } else {
      const { traces, x_label, y_label } = build_scatter_traces(
        dr_result.embedding,
        dr_result.labels ?? null,
        dr_result.frame_indices,
        dr_result.method,
        dr_result.explained_variance ?? null,
      )
      on_plot?.({
        traces,
        title: `Dimensionality Reduction (${dr_result.method.toUpperCase()})`,
        x_label,
        y_label,
      })
    }
  })
</script>

<div class="clustering-panel">
  <!-- ===================================================================
       Section 1: RMSD-based Clustering
       =================================================================== -->
  <details open>
    <summary>RMSD-based Clustering</summary>

    <div class="param-grid">
      <label>
        Method
        <select bind:value={rmsd_method}>
          <option value="dbscan">DBSCAN</option>
          <option value="kmeans">KMeans</option>
          <option value="hierarchical">Hierarchical</option>
        </select>
      </label>

      {#if rmsd_method === `dbscan`}
        <label>
          Epsilon (A)
          <input type="number" bind:value={rmsd_eps} step="0.1" min="0.01" />
        </label>
        <label>
          Min samples
          <input type="number" bind:value={rmsd_min_samples} step="1" min="1" />
        </label>
      {/if}

      {#if rmsd_method === `kmeans`}
        <label>
          N clusters
          <input type="number" bind:value={rmsd_n_clusters} step="1" min="2" />
        </label>
      {/if}

      {#if rmsd_method === `hierarchical`}
        <label>
          N clusters
          <input type="number" bind:value={rmsd_n_clusters} step="1" min="2" />
        </label>
        <label>
          Linkage
          <select bind:value={rmsd_linkage}>
            <option value="ward">Ward</option>
            <option value="average">Average</option>
            <option value="complete">Complete</option>
          </select>
        </label>
      {/if}

      <label>
        Atom indices
        <input
          type="text"
          bind:value={rmsd_atom_indices_text}
          placeholder="e.g. 0,1,2,5,8"
          title="Comma-separated 0-indexed atom indices (empty = all)"
        />
      </label>

      <label>
        Stride
        <input type="number" bind:value={rmsd_stride} step="1" min="1" />
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={run_rmsd_cluster}
      disabled={rmsd_computing}
    >
      {#if rmsd_computing}
        <Spinner /> Clustering...
      {:else}
        Cluster
      {/if}
    </button>

    {#if rmsd_error}
      <div class="error-msg">{rmsd_error}</div>
    {/if}

    {#if rmsd_result}
      <div class="cluster-info">
        <strong>Clusters found: {rmsd_result.n_clusters_found}</strong>
        <ul class="cluster-sizes">
          {#each Object.entries(rmsd_result.cluster_sizes).sort(([a], [b]) => parseInt(a) - parseInt(b)) as [label, count]}
            <li>
              <span class="cluster-badge" style:background={label === `-1` ? `#666` : CLUSTER_COLORS[parseInt(label) % CLUSTER_COLORS.length]}>
                {label === `-1` ? `Noise` : `Cluster ${label}`}
              </span>
              {count} frames
              {#if rmsd_result.representative_frames[label] !== undefined}
                <span class="rep-frame">(rep: frame {rmsd_result.representative_frames[label]})</span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </details>

  <!-- ===================================================================
       Section 2: CV-based Clustering
       =================================================================== -->
  <details>
    <summary>CV-based Clustering</summary>

    <div class="param-grid">
      <label>
        CV type
        <select bind:value={cv_type}>
          <option value="distances">Distances</option>
          <option value="angles">Angles</option>
          <option value="dihedrals">Dihedrals</option>
          <option value="contacts">Contacts</option>
          <option value="mixed">Mixed</option>
        </select>
      </label>
    </div>

    <!-- CV-specific inputs -->
    {#if cv_type === `distances`}
      <div class="cv-inputs">
        <label>
          Atom pairs (0-indexed)
          <input
            type="text"
            bind:value={cv_pairs_text}
            placeholder="0,1 ; 2,3 ; 4,5"
            title="Semicolon-separated atom index pairs"
          />
        </label>
      </div>
    {:else if cv_type === `angles`}
      <div class="cv-inputs">
        <label>
          Atom triplets (0-indexed)
          <input
            type="text"
            bind:value={cv_triplets_text}
            placeholder="0,1,2 ; 3,4,5"
            title="Semicolon-separated atom index triplets (j is vertex)"
          />
        </label>
      </div>
    {:else if cv_type === `dihedrals`}
      <div class="cv-inputs">
        <label>
          Atom quartets (0-indexed)
          <input
            type="text"
            bind:value={cv_quartets_text}
            placeholder="0,1,2,3 ; 4,5,6,7"
            title="Semicolon-separated atom index quartets"
          />
        </label>
      </div>
    {:else if cv_type === `contacts`}
      <div class="cv-inputs">
        <label>
          Scheme
          <select bind:value={cv_scheme}>
            <option value="closest-heavy">Closest heavy</option>
            <option value="ca">C-alpha</option>
          </select>
        </label>
        <label>
          Cutoff (A)
          <input type="number" bind:value={cv_cutoff} step="0.5" min="0.1" />
        </label>
      </div>
    {:else if cv_type === `mixed`}
      <div class="cv-mixed-section">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cv_mixed_distances} />
          Distances
        </label>
        {#if cv_mixed_distances}
          <div class="cv-inputs indented">
            <label>
              Atom pairs
              <input type="text" bind:value={cv_pairs_text} placeholder="0,1 ; 2,3" />
            </label>
          </div>
        {/if}

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cv_mixed_angles} />
          Angles
        </label>
        {#if cv_mixed_angles}
          <div class="cv-inputs indented">
            <label>
              Atom triplets
              <input type="text" bind:value={cv_triplets_text} placeholder="0,1,2 ; 3,4,5" />
            </label>
          </div>
        {/if}

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cv_mixed_dihedrals} />
          Dihedrals
        </label>
        {#if cv_mixed_dihedrals}
          <div class="cv-inputs indented">
            <label>
              Atom quartets
              <input type="text" bind:value={cv_quartets_text} placeholder="0,1,2,3 ; 4,5,6,7" />
            </label>
          </div>
        {/if}

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cv_mixed_contacts} />
          Contacts
        </label>
        {#if cv_mixed_contacts}
          <div class="cv-inputs indented">
            <label>
              Scheme
              <select bind:value={cv_scheme}>
                <option value="closest-heavy">Closest heavy</option>
                <option value="ca">C-alpha</option>
              </select>
            </label>
            <label>
              Cutoff (A)
              <input type="number" bind:value={cv_cutoff} step="0.5" min="0.1" />
            </label>
          </div>
        {/if}
      </div>
    {/if}

    <div class="param-grid" style="margin-top: 8px;">
      <label>
        Clustering method
        <select bind:value={cv_cluster_method}>
          <option value="dbscan">DBSCAN</option>
          <option value="kmeans">KMeans</option>
          <option value="hierarchical">Hierarchical</option>
        </select>
      </label>

      {#if cv_cluster_method === `dbscan`}
        <label>
          Epsilon
          <input type="number" bind:value={cv_eps} step="0.1" min="0.01" />
        </label>
        <label>
          Min samples
          <input type="number" bind:value={cv_min_samples} step="1" min="1" />
        </label>
      {/if}

      {#if cv_cluster_method === `kmeans`}
        <label>
          N clusters
          <input type="number" bind:value={cv_n_clusters} step="1" min="2" />
        </label>
      {/if}

      {#if cv_cluster_method === `hierarchical`}
        <label>
          N clusters
          <input type="number" bind:value={cv_n_clusters} step="1" min="2" />
        </label>
        <label>
          Linkage
          <select bind:value={cv_linkage}>
            <option value="ward">Ward</option>
            <option value="average">Average</option>
            <option value="complete">Complete</option>
          </select>
        </label>
      {/if}

      <label>
        Stride
        <input type="number" bind:value={cv_stride} step="1" min="1" />
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={run_cv_cluster}
      disabled={cv_computing}
    >
      {#if cv_computing}
        <Spinner /> Clustering...
      {:else}
        Cluster
      {/if}
    </button>

    {#if cv_error}
      <div class="error-msg">{cv_error}</div>
    {/if}

    {#if cv_result}
      <div class="cluster-info">
        <strong>Clusters found: {cv_result.n_clusters_found}</strong>
        <span class="cv-dims">{cv_result.cv_names.length} CVs: {cv_result.cv_names.join(`, `)}</span>
        <ul class="cluster-sizes">
          {#each Object.entries(cv_result.cluster_sizes).sort(([a], [b]) => parseInt(a) - parseInt(b)) as [label, count]}
            <li>
              <span class="cluster-badge" style:background={label === `-1` ? `#666` : CLUSTER_COLORS[parseInt(label) % CLUSTER_COLORS.length]}>
                {label === `-1` ? `Noise` : `Cluster ${label}`}
              </span>
              {count} frames
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </details>

  <!-- ===================================================================
       Section 3: Dimensionality Reduction
       =================================================================== -->
  <details>
    <summary>Dimensionality Reduction</summary>

    <div class="param-grid">
      <label>
        Feature source
        <select bind:value={dr_feature_type}>
          <option value="coordinates">Coordinates</option>
          <option value="rmsd_matrix">RMSD matrix</option>
          <option value="custom_cv">Custom CV</option>
        </select>
      </label>

      <label>
        Method
        <select bind:value={dr_method}>
          <option value="pca">PCA</option>
          <option value="tsne">t-SNE</option>
          <option value="umap">UMAP</option>
        </select>
      </label>

      <label>
        Components
        <select bind:value={dr_n_components}>
          <option value={2}>2D</option>
          <option value={3}>3D</option>
        </select>
      </label>
    </div>

    <!-- Custom CV params (when feature_type = custom_cv) -->
    {#if dr_feature_type === `custom_cv`}
      <div class="subsection">
        <span class="subsection-title">Custom CV Parameters</span>
        <div class="param-grid">
          <label>
            CV type
            <select bind:value={dr_cv_type}>
              <option value="distances">Distances</option>
              <option value="angles">Angles</option>
              <option value="dihedrals">Dihedrals</option>
              <option value="contacts">Contacts</option>
              <option value="mixed">Mixed</option>
            </select>
          </label>
        </div>
        <div class="cv-inputs">
          {#if dr_cv_type === `distances` || dr_cv_type === `mixed`}
            <label>
              Atom pairs
              <input type="text" bind:value={dr_cv_pairs_text} placeholder="0,1 ; 2,3" />
            </label>
          {/if}
          {#if dr_cv_type === `angles` || dr_cv_type === `mixed`}
            <label>
              Atom triplets
              <input type="text" bind:value={dr_cv_triplets_text} placeholder="0,1,2 ; 3,4,5" />
            </label>
          {/if}
          {#if dr_cv_type === `dihedrals` || dr_cv_type === `mixed`}
            <label>
              Atom quartets
              <input type="text" bind:value={dr_cv_quartets_text} placeholder="0,1,2,3 ; 4,5,6,7" />
            </label>
          {/if}
          {#if dr_cv_type === `contacts` || dr_cv_type === `mixed`}
            <label>
              Scheme
              <select bind:value={dr_cv_scheme}>
                <option value="closest-heavy">Closest heavy</option>
                <option value="ca">C-alpha</option>
              </select>
            </label>
            <label>
              Cutoff (A)
              <input type="number" bind:value={dr_cv_cutoff} step="0.5" min="0.1" />
            </label>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Method-specific params -->
    {#if dr_method === `tsne`}
      <div class="param-grid">
        <label>
          Perplexity
          <input type="number" bind:value={dr_perplexity} step="5" min="1" />
        </label>
        <label>
          Learning rate
          <input type="number" bind:value={dr_learning_rate} step="50" min="1" />
        </label>
      </div>
    {/if}

    {#if dr_method === `umap`}
      <div class="param-grid">
        <label>
          N neighbors
          <input type="number" bind:value={dr_n_neighbors} step="1" min="2" />
        </label>
        <label>
          Min dist
          <input type="number" bind:value={dr_min_dist} step="0.05" min="0" />
        </label>
      </div>
    {/if}

    <div class="param-grid">
      <label>
        Atom indices
        <input
          type="text"
          bind:value={dr_atom_indices_text}
          placeholder="e.g. 0,1,2,5,8"
          title="Comma-separated 0-indexed atom indices (empty = all)"
        />
      </label>

      <label>
        Stride
        <input type="number" bind:value={dr_stride} step="1" min="1" />
      </label>
    </div>

    <!-- Optional clustering on the embedding -->
    <div class="subsection">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={dr_cluster_enabled} />
        Cluster on embedding
      </label>

      {#if dr_cluster_enabled}
        <div class="param-grid">
          <label>
            Method
            <select bind:value={dr_cluster_method}>
              <option value="dbscan">DBSCAN</option>
              <option value="kmeans">KMeans</option>
              <option value="hierarchical">Hierarchical</option>
            </select>
          </label>

          {#if dr_cluster_method === `dbscan`}
            <label>
              Epsilon
              <input type="number" bind:value={dr_cluster_eps} step="0.1" min="0.01" />
            </label>
            <label>
              Min samples
              <input type="number" bind:value={dr_cluster_min_samples} step="1" min="1" />
            </label>
          {/if}

          {#if dr_cluster_method === `kmeans`}
            <label>
              N clusters
              <input type="number" bind:value={dr_cluster_n_clusters} step="1" min="2" />
            </label>
          {/if}

          {#if dr_cluster_method === `hierarchical`}
            <label>
              N clusters
              <input type="number" bind:value={dr_cluster_n_clusters} step="1" min="2" />
            </label>
            <label>
              Linkage
              <select bind:value={dr_cluster_linkage}>
                <option value="ward">Ward</option>
                <option value="average">Average</option>
                <option value="complete">Complete</option>
              </select>
            </label>
          {/if}
        </div>
      {/if}
    </div>

    <button
      class="btn-compute"
      onclick={run_dimreduce}
      disabled={dr_computing}
    >
      {#if dr_computing}
        <Spinner /> Reducing...
      {:else}
        Reduce
      {/if}
    </button>

    {#if dr_error}
      <div class="error-msg">{dr_error}</div>
    {/if}

    {#if dr_result}
      <div class="cluster-info">
        <span class="method-badge">{dr_result.method.toUpperCase()}</span>
        {#if dr_result.explained_variance}
          <span class="variance-info">
            Explained variance:
            {dr_result.explained_variance.map((v) => `${(v * 100).toFixed(1)}%`).join(`, `)}
          </span>
        {/if}
        {#if dr_result.labels}
          {@const unique_labels = [...new Set(dr_result.labels)].sort((a, b) => a - b)}
          {@const n_clusters = unique_labels.filter((l) => l !== -1).length}
          <strong>{n_clusters} cluster{n_clusters !== 1 ? `s` : ``} found</strong>
          <ul class="cluster-sizes">
            {#each unique_labels as label}
              {@const count = dr_result.labels.filter((l) => l === label).length}
              <li>
                <span class="cluster-badge" style:background={label === -1 ? `#666` : CLUSTER_COLORS[label % CLUSTER_COLORS.length]}>
                  {label === -1 ? `Noise` : `Cluster ${label}`}
                </span>
                {count} frames
              </li>
            {/each}
          </ul>
        {:else}
          <span class="info-text">{dr_result.frame_indices.length} frames embedded (colored by frame index)</span>
        {/if}
      </div>
    {/if}
  </details>
</div>

<style>
  .clustering-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.82em;
  }

  details {
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.03));
    border-radius: 6px;
    padding: 6px 8px;
  }

  summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 0.88em;
    color: var(--text-color);
    user-select: none;
  }

  /* Parameter grid */
  .param-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 6px;
  }

  .param-grid label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.85em;
    color: var(--text-color-muted);
  }

  .param-grid select,
  .param-grid input[type="number"],
  .param-grid input[type="text"] {
    padding: 3px 5px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    border-radius: 4px;
    color: var(--text-color);
    font-size: 0.95em;
    width: 100%;
    box-sizing: border-box;
  }

  /* CV-specific inputs */
  .cv-inputs {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 6px;
  }

  .cv-inputs label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.85em;
    color: var(--text-color-muted);
  }

  .cv-inputs input[type="text"],
  .cv-inputs input[type="number"],
  .cv-inputs select {
    padding: 3px 5px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    border-radius: 4px;
    color: var(--text-color);
    font-size: 0.95em;
    width: 100%;
    box-sizing: border-box;
  }

  .cv-inputs.indented {
    margin-left: 18px;
  }

  .cv-mixed-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }

  /* Checkbox labels */
  .checkbox-label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 5px;
    font-size: 0.85em;
    color: var(--text-color-muted);
    cursor: pointer;
  }

  /* Subsections */
  .subsection {
    margin-top: 6px;
    padding: 5px 6px;
    background: light-dark(rgba(0, 0, 0, 0.02), rgba(255, 255, 255, 0.02));
    border-radius: 4px;
    border-left: 2px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
  }

  .subsection-title {
    font-size: 0.85em;
    font-weight: 500;
    color: var(--text-color-muted);
    margin-bottom: 4px;
    display: block;
  }

  /* Compute button */
  .btn-compute {
    margin-top: 8px;
    padding: 6px 12px;
    background: var(--accent-color, #007acc);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9em;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .btn-compute:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Cluster info */
  .cluster-info {
    margin-top: 6px;
    font-size: 0.85em;
    color: var(--text-color-muted);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cluster-info strong {
    color: var(--text-color);
  }

  .cluster-sizes {
    list-style: none;
    padding: 0;
    margin: 2px 0 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .cluster-sizes li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05));
  }

  .cluster-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    color: #fff;
    font-size: 0.85em;
    font-weight: 500;
    min-width: 70px;
    text-align: center;
  }

  .rep-frame {
    font-size: 0.85em;
    color: var(--text-color-dim);
    font-style: italic;
  }

  .cv-dims {
    font-size: 0.8em;
    color: var(--text-color-dim);
    word-break: break-word;
  }

  .method-badge {
    display: inline-block;
    padding: 1px 6px;
    background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1));
    border-radius: 3px;
    font-weight: 600;
    color: var(--text-color);
    font-size: 0.9em;
    align-self: flex-start;
  }

  .variance-info {
    font-size: 0.85em;
    font-family: monospace;
  }

  .info-text {
    font-size: 0.85em;
    color: var(--text-color-dim);
  }

  /* Error message */
  .error-msg {
    margin-top: 6px;
    padding: 5px 8px;
    background: light-dark(rgba(220, 60, 60, 0.1), rgba(255, 60, 60, 0.15));
    border: 1px solid light-dark(rgba(220, 60, 60, 0.25), rgba(255, 60, 60, 0.3));
    border-radius: 4px;
    color: var(--error-color);
    font-size: 0.85em;
  }
</style>
