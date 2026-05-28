<!-- src/lib/workflow/WorkflowDAGViewer.svelte -->
<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { get_v2_dag, connect_v2_monitor, confirm_all_engine_tasks, type V2Task, type V2Link, type V2DAG } from '$lib/api/workflow-v2'
  import { get_v2_task_result, retry_v2_task } from '$lib/api/workflow-v2'

  load_i18n_module(`workflow`)

  interface Props {
    workflow_id: string
    onselect_task?: (task_id: string) => void
  }
  let { workflow_id, onselect_task }: Props = $props()

  let tasks = $state<V2Task[]>([])
  let links = $state.raw<V2Link[]>([])
  let selected = $state<string | null>(null)
  let error = $state('')
  let pan = $state({ x: 40, y: 40 })
  let zoom = $state(1)

  const NW = 260
  const NH = 72
  const HANDLE_R = 7
  const H_GAP = 100
  const V_GAP = 40

  const STATUS_COLORS: Record<string, string> = {
    WAITING: '#475569',
    READY: '#3b82f6',
    GENERATING: '#a78bfa',
    UPLOADING: '#a78bfa',
    SUBMITTED: '#8b5cf6',
    QUEUED: '#a78bfa',
    RUNNING: '#eab308',
    COMPLETED_REMOTE: '#84cc16',
    COLLECTING: '#84cc16',
    COMPLETED: '#22c55e',
    FAILED: '#ef4444',
    REMOTE_ERROR: '#f97316',
    PENDING_REVIEW: '#f59e0b',
    PAUSED: '#64748b',
    CANCELLED: '#6b7280',
  }

  let has_pending_review = $derived(tasks.some(t => t.status === 'PENDING_REVIEW'))
  let confirming_all = $state(false)

  async function do_confirm_all() {
    confirming_all = true
    try {
      await confirm_all_engine_tasks(workflow_id)
      await load()
    } catch (e: any) {
      error = e.message
    } finally {
      confirming_all = false
    }
  }

  // Auto-layout: topological layers left→right
  function layout(dag: V2DAG): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>()
    const task_map = new Map(dag.tasks.map(t => [t.id, t]))
    const in_degree = new Map<string, number>()
    const children_map = new Map<string, string[]>()

    for (const t of dag.tasks) {
      in_degree.set(t.id, 0)
      children_map.set(t.id, [])
    }
    for (const l of dag.links) {
      in_degree.set(l.target_task_id, (in_degree.get(l.target_task_id) ?? 0) + 1)
      children_map.get(l.source_task_id)?.push(l.target_task_id)
    }

    // BFS layers
    const layers: string[][] = []
    const queue = [...dag.tasks.filter(t => (in_degree.get(t.id) ?? 0) === 0).map(t => t.id)]
    const visited = new Set<string>()

    while (queue.length > 0) {
      const layer = [...queue]
      layers.push(layer)
      queue.length = 0
      for (const id of layer) {
        visited.add(id)
        for (const child of children_map.get(id) ?? []) {
          in_degree.set(child, (in_degree.get(child) ?? 0) - 1)
          if ((in_degree.get(child) ?? 0) <= 0 && !visited.has(child)) {
            queue.push(child)
            visited.add(child)
          }
        }
      }
    }

    // Place unvisited nodes (cycles) in final layer
    const remaining = dag.tasks.filter(t => !visited.has(t.id)).map(t => t.id)
    if (remaining.length) layers.push(remaining)

    for (let col = 0; col < layers.length; col++) {
      const layer = layers[col]
      for (let row = 0; row < layer.length; row++) {
        positions.set(layer[row], {
          x: col * (NW + H_GAP),
          y: row * (NH + V_GAP),
        })
      }
    }
    return positions
  }

  let positions = $state(new Map<string, { x: number; y: number }>())

  async function load() {
    try {
      const dag = await get_v2_dag(workflow_id)
      tasks = dag.tasks
      links = dag.links
      positions = layout(dag)
    } catch (e: any) {
      error = e.message
    }
  }

  let task_results = $state<Map<string, Record<string, unknown>>>(new Map())

  async function load_results() {
    const completed = tasks.filter(t => t.status === 'COMPLETED')
    const results = await Promise.allSettled(
      completed.map(t => get_v2_task_result(t.id).then(r => [t.id, r] as const))
    )
    const new_map = new Map(task_results)
    for (const r of results) {
      if (r.status === 'fulfilled') {
        new_map.set(r.value[0], r.value[1])
      }
    }
    task_results = new_map
  }

  let retrying_all = $state(false)

  async function retry_all_failed() {
    retrying_all = true
    try {
      const failed = tasks.filter(t => t.status === 'FAILED' || t.status === 'REMOTE_ERROR')
      await Promise.allSettled(failed.map(t => retry_v2_task(t.id)))
      await load()
      await load_results()
    } catch (e: any) {
      error = e.message
    } finally {
      retrying_all = false
    }
  }

  $effect(() => { load().then(() => load_results()) })

  // WebSocket monitoring
  let monitor: { close: () => void } | null = null

  $effect(() => {
    monitor?.close()
    monitor = connect_v2_monitor(workflow_id, {
      on_task_status(task_id, status) {
        const idx = tasks.findIndex(t => t.id === task_id)
        if (idx >= 0) tasks[idx] = { ...tasks[idx], status }
      },
      on_workflow_status(_status) {
        // Could update a workflow-level badge here
      },
    })
    return () => { monitor?.close(); monitor = null }
  })

  function edge_path(link: V2Link): string {
    const src = positions.get(link.source_task_id)
    const tgt = positions.get(link.target_task_id)
    if (!src || !tgt) return ''
    const x1 = src.x + NW
    const y1 = src.y + NH / 2
    const x2 = tgt.x
    const y2 = tgt.y + NH / 2
    const cx = (x1 + x2) / 2
    return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`
  }

  // Pan/zoom
  let dragging = $state(false)
  let drag_start = $state({ x: 0, y: 0 })

  // Node dragging
  let dragging_node = $state<string | null>(null)
  let drag_offset = $state({ x: 0, y: 0 })
  let did_drag = $state(false)

  function on_bg_down(e: MouseEvent) {
    if (e.button !== 0) return
    dragging = true
    drag_start = { x: e.clientX - pan.x, y: e.clientY - pan.y }
  }
  function on_bg_move(e: MouseEvent) {
    if (dragging_node) {
      const svg = (e.currentTarget as Element)?.querySelector?.('svg') ?? e.currentTarget as SVGSVGElement | null
      if (!svg || !('createSVGPoint' in svg)) return
      const pt = (svg as SVGSVGElement).createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const svgP = pt.matrixTransform((svg as SVGSVGElement).getScreenCTM()?.inverse())
      const new_x = svgP.x / zoom - pan.x / zoom - drag_offset.x
      const new_y = svgP.y / zoom - pan.y / zoom - drag_offset.y
      positions.set(dragging_node, { x: new_x, y: new_y })
      positions = new Map(positions)  // trigger reactivity
      did_drag = true
      return
    }
    if (!dragging) return
    pan = { x: e.clientX - drag_start.x, y: e.clientY - drag_start.y }
  }
  function on_bg_up() {
    if (dragging_node) {
      dragging_node = null
      return
    }
    dragging = false
  }
  function on_wheel(e: WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    zoom = Math.max(0.3, Math.min(3, zoom * delta))
  }
</script>

<div class="dag-viewer"
  onmousedown={on_bg_down}
  onmousemove={on_bg_move}
  onmouseup={on_bg_up}
  onmouseleave={on_bg_up}
  onwheel={on_wheel}
  role="application"
>
  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if has_pending_review}
    <div class="confirm-all-bar">
      <span class="confirm-label">{t(`workflow.tasks_awaiting_review`)}</span>
      <button class="confirm-all-btn" onclick={do_confirm_all} disabled={confirming_all}>
        {confirming_all ? t(`workflow.confirming`) : t(`workflow.confirm_all_submit`)}
      </button>
    </div>
  {/if}

  {#if tasks.length > 0}
  {@const status_counts = (() => {
    const c = { total: 0, completed: 0, running: 0, failed: 0, pending: 0 }
    for (const t of tasks) {
      if (t.task_type.startsWith('__')) continue
      c.total++
      if (t.status === 'COMPLETED') c.completed++
      else if (['RUNNING', 'QUEUED', 'SUBMITTED', 'GENERATING', 'UPLOADING', 'COLLECTING', 'COMPLETED_REMOTE'].includes(t.status)) c.running++
      else if (t.status === 'FAILED' || t.status === 'REMOTE_ERROR') c.failed++
      else c.pending++
    }
    return c
  })()}
  {#if status_counts.total > 0}
    <div class="progress-bar-area">
      <div class="wf-progress-bar">
        <div class="wf-progress-fill completed" style="width:{status_counts.completed / status_counts.total * 100}%"></div>
        <div class="wf-progress-fill running" style="width:{status_counts.running / status_counts.total * 100}%"></div>
        <div class="wf-progress-fill failed" style="width:{status_counts.failed / status_counts.total * 100}%"></div>
      </div>
      <div class="wf-progress-label">
        {status_counts.completed}/{status_counts.total} complete
        {#if status_counts.running > 0} | {status_counts.running} running{/if}
        {#if status_counts.failed > 0} | {status_counts.failed} failed{/if}
      </div>
      {#if status_counts.failed > 0}
        <button class="retry-all-btn" onclick={retry_all_failed} disabled={retrying_all}>
          {retrying_all ? 'Retrying...' : 'Retry All Failed'}
        </button>
      {/if}
    </div>
  {/if}
  {/if}

  <svg width="100%" height="100%">
    <g transform="translate({pan.x},{pan.y}) scale({zoom})">
      <!-- Edges -->
      {#each links as link}
        {@const path = edge_path(link)}
        {#if path}
          <path d={path} fill="none" stroke="var(--border-color, #555)" stroke-width={1.8} />
          <circle r={2.5} fill="var(--accent-color, #3b82f6)" opacity={0.7}>
            <animateMotion dur="2.5s" repeatCount="indefinite" path={path} />
          </circle>
        {/if}
      {/each}

      <!-- Group containers (behind nodes) -->
      {#each tasks.filter(t => ['__map__', '__zone__', '__while__'].includes(t.task_type)) as group_task}
        {@const children_pos = tasks.filter(t => t.parent_task_id === group_task.id).map(t => positions.get(t.id)).filter((p): p is {x: number; y: number} => !!p)}
        {#if children_pos.length > 0}
          {@const min_x = Math.min(...children_pos.map(p => p.x)) - 20}
          {@const min_y = Math.min(...children_pos.map(p => p.y)) - 30}
          {@const max_x = Math.max(...children_pos.map(p => p.x)) + NW + 20}
          {@const max_y = Math.max(...children_pos.map(p => p.y)) + NH + 20}
          <rect x={min_x} y={min_y} width={max_x - min_x} height={max_y - min_y} rx={12}
            fill="none"
            stroke={group_task.task_type === '__while__' ? '#eab308' : group_task.task_type === '__map__' ? '#3b82f6' : '#6b7280'}
            stroke-width={1.5}
            stroke-dasharray={group_task.task_type === '__while__' ? '' : '6 4'}
            opacity={0.6}
          />
          <text x={min_x + 8} y={min_y - 6} fill={group_task.task_type === '__while__' ? '#eab308' : '#6b7280'} font-size="10" font-weight="600">
            {group_task.task_type === '__map__' ? `Map: ${children_pos.length} branches` : group_task.task_type === '__while__' ? `Loop ${group_task.name || ''}` : group_task.name || 'Zone'}
          </text>
        {/if}
      {/each}

      <!-- Task Nodes (skip control-flow parent tasks) -->
      {#each tasks.filter(t => !['__map__', '__zone__', '__while__'].includes(t.task_type)) as task}
        {@const pos = positions.get(task.id)}
        {#if pos}
          {@const scolor = STATUS_COLORS[task.status] ?? '#475569'}
          {@const is_sel = selected === task.id}
          <g transform="translate({pos.x},{pos.y})"
            onmousedown={(e) => {
              e.stopPropagation()
              if (e.button !== 0) return
              dragging_node = task.id
              did_drag = false
              const p = positions.get(task.id)
              if (!p) return
              const svg = (e.currentTarget as Element).closest('svg')
              if (!svg) return
              const pt = svg.createSVGPoint()
              pt.x = e.clientX
              pt.y = e.clientY
              const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse())
              drag_offset = { x: svgP.x / zoom - pan.x / zoom - p.x, y: svgP.y / zoom - pan.y / zoom - p.y }
            }}
            onclick={() => {
              if (did_drag) { did_drag = false; return }
              selected = task.id
              onselect_task?.(task.id)
            }}
            style="cursor:{dragging_node === task.id ? 'grabbing' : 'grab'}"
          >
            <!-- Shadow -->
            <rect x={2} y={2} width={NW} height={NH} rx={10} fill="rgba(0,0,0,0.25)" />
            <!-- Card -->
            <rect width={NW} height={NH} rx={10}
              fill="var(--surface-bg, #111827)"
              stroke={is_sel ? 'var(--accent-color, #3b82f6)' : scolor + '60'}
              stroke-width={is_sel ? 2.5 : 1.5}
            />
            <!-- Header bar -->
            <rect width={NW} height={28} rx={10} fill={scolor} opacity={0.85} />
            <rect y={14} width={NW} height={14} fill={scolor} opacity={0.85} />
            <!-- Title -->
            <text x={12} y={19} fill="#fff" font-size="12" font-weight="600">
              {task.task_type}{task.system_name ? ` (${task.system_name})` : ''}
            </text>
            <!-- Status badge -->
            <g transform="translate({NW - 12}, 14)">
              <circle r={4} fill="#fff" opacity={0.9} />
              {#if task.status === 'RUNNING'}
                <circle r={4} fill="#fff" opacity={0.6}>
                  <animate attributeName="r" values="4;7;4" dur="1s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.6;0;0.6" dur="1s" repeatCount="indefinite" />
                </circle>
              {/if}
            </g>
            <!-- Status text -->
            {#if typeof task_results.get(task.id)?.energy === 'number'}
              <text x={NW / 2} y={50} fill="#22c55e" font-size="10" text-anchor="middle" font-family="monospace">
                {(task_results.get(task.id)!.energy as number).toFixed(4)} eV
              </text>
            {:else if typeof task_results.get(task.id)?.energy_ev === 'number'}
              <text x={NW / 2} y={50} fill="#22c55e" font-size="10" text-anchor="middle" font-family="monospace">
                {(task_results.get(task.id)!.energy_ev as number).toFixed(4)} eV
              </text>
            {:else}
              <text x={NW / 2} y={50} fill="var(--text-color-dim, #999)" font-size="10" text-anchor="middle">
                {task.status}
              </text>
            {/if}
            <!-- Name -->
            {#if task.name}
              <text x={NW / 2} y={64} fill="var(--text-color-dim, #888)" font-size="9" text-anchor="middle">
                {task.name}
              </text>
            {:else}
              {@const species = (() => {
                if (task.task_type !== 'adsorbate_place') return null
                try {
                  const p = JSON.parse(task.params_json ?? '{}')
                  return p.adsorbate_species ?? p.species ?? p.adsorbate ?? null
                } catch { return null }
              })()}
              {#if species}
                <text x={NW / 2} y={64} fill="#34d399" font-size="10" text-anchor="middle" font-weight="600">
                  {species}
                </text>
              {/if}
            {/if}
            <!-- Input handle -->
            <circle cx={0} cy={NH / 2} r={HANDLE_R} fill="var(--surface-bg, #111)" stroke={scolor} stroke-width={1.5} />
            <!-- Output handle -->
            <circle cx={NW} cy={NH / 2} r={HANDLE_R} fill="var(--surface-bg, #111)" stroke={scolor} stroke-width={1.5} />
          </g>
        {/if}
      {/each}
    </g>
  </svg>
</div>

<style>
  .dag-viewer {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--page-bg, #0a0a0a);
    position: relative;
    user-select: none;
  }
  svg { display: block; }
  .error { position: absolute; top: 8px; left: 8px; color: #ef4444; font-size: 13px; z-index: 10; }
  .confirm-all-bar {
    position: absolute; top: 8px; right: 8px; z-index: 10;
    display: flex; align-items: center; gap: 10px;
    background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b;
    border-radius: 8px; padding: 6px 14px;
  }
  .confirm-label { color: #f59e0b; font-size: 12px; font-weight: 500; }
  .confirm-all-btn {
    background: #f59e0b; color: #000; border: none; border-radius: 6px;
    padding: 5px 14px; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .confirm-all-btn:hover { background: #d97706; }
  .confirm-all-btn:disabled { opacity: 0.6; cursor: default; }
  .progress-bar-area {
    position: absolute; bottom: 0; left: 0; right: 0; z-index: 10;
    display: flex; align-items: center; gap: 10px;
    background: var(--surface-bg, #111); border-top: 1px solid var(--border-color, #333);
    padding: 6px 14px;
  }
  .wf-progress-bar {
    width: 200px; height: 6px; background: #1e293b; border-radius: 3px;
    display: flex; overflow: hidden;
  }
  .wf-progress-fill { height: 100%; transition: width 0.3s; }
  .wf-progress-fill.completed { background: #22c55e; }
  .wf-progress-fill.running { background: #eab308; }
  .wf-progress-fill.failed { background: #ef4444; }
  .wf-progress-label { color: var(--text-color-dim, #888); font-size: 11px; white-space: nowrap; }
  .retry-all-btn {
    background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid #ef4444;
    border-radius: 6px; padding: 4px 12px; font-size: 11px; cursor: pointer;
  }
  .retry-all-btn:hover { background: rgba(239, 68, 68, 0.25); }
  .retry-all-btn:disabled { opacity: 0.5; cursor: default; }
</style>
