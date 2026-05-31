/**
 * Per-workflow run-config persistence.
 *
 * The Run dialog assembles a full `WorkflowRunConfig` (execution mode, cluster
 * configs, job params, base work dir, poll interval, custodian, …). That config
 * is needed again by the in-app AI (CatBot client-direct tools) so it can
 * RE-RUN a workflow without re-opening the dialog. We persist the last-used
 * config to localStorage keyed by workflow id.
 *
 * Key shape: `catgo_run_config_<workflow_id>` → JSON-serialized WorkflowRunConfig.
 */

import type { WorkflowRunConfig } from './workflow-types'

const RUN_CONFIG_PREFIX = `catgo_run_config_`

/** localStorage key for a workflow's last-used run config. */
export function run_config_key(workflow_id: string): string {
  return `${RUN_CONFIG_PREFIX}${workflow_id}`
}

/** Persist the last-used run config for a workflow (best-effort; never throws). */
export function save_run_config(workflow_id: string, config: WorkflowRunConfig): void {
  if (!workflow_id) return
  try {
    localStorage.setItem(run_config_key(workflow_id), JSON.stringify(config))
  } catch {
    // localStorage unavailable / quota — non-fatal, the dialog still runs.
  }
}

/** Load the persisted run config for a workflow, or null if none / unparseable. */
export function load_run_config(workflow_id: string): WorkflowRunConfig | null {
  if (!workflow_id) return null
  try {
    const raw = localStorage.getItem(run_config_key(workflow_id))
    if (!raw) return null
    return JSON.parse(raw) as WorkflowRunConfig
  } catch {
    return null
  }
}
