/**
 * CatBot client-direct tool for the CatGo Campaign md-orchestration system.
 *
 * The catgo_campaign MCP tool is backend-only (SDK agents: Claude Code/Codex/
 * Gemini). This gives the API / client-direct providers (DeepSeek / Qwen /
 * custom OpenAI) the same capability by POSTing to the backend
 * `POST /api/campaign/run` endpoint. Registered into CLIENT_TOOLS by
 * structure-tools.ts. kind: 'mutate' so every campaign action is confirmed via
 * the existing PermissionCard before it runs.
 */
import type { ClientTool } from './types'
import { API_BASE } from '$lib/api/config'

export interface CampaignToolEntry {
  def: ClientTool
  run: (input: Record<string, unknown>) => Promise<unknown>
}

const ACTIONS = [
  'new', 'fetch-ref', 'submit', 'poll', 'aggregate', 'report', 'ingest', 'archive',
]

export const CAMPAIGN_TOOLS: CampaignToolEntry[] = [
  {
    def: {
      name: 'campaign',
      kind: 'mutate',
      description:
        'Create and drive a CatGo Campaign — the md-orchestration system for ' +
        'exploratory / HPC research studies (agent-driven folder + markdown). ' +
        'Actions map to the `catgo campaign` CLI: new (scaffold a folder — args: ' +
        '[<absolute_path>, "--name", <name>, "--template", "blank"|"saa_her"]), ' +
        'fetch-ref, submit, poll, aggregate, report, ingest, archive. After `new` ' +
        'the campaign lives as files on disk. Pass extra CLI args verbatim in `args`.',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ACTIONS,
            description: 'The campaign CLI action.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Extra CLI args passed verbatim, e.g. ' +
              '["/home/me/study", "--name", "my-study", "--template", "blank"].',
          },
        },
        required: ['action'],
      },
    },
    run: async (input) => {
      const action = String(input.action ?? '')
      const args = Array.isArray(input.args) ? input.args.map(String) : []
      const resp = await fetch(`${API_BASE}/campaign/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, args }),
      })
      if (!resp.ok) {
        const detail = await resp.text().catch(() => `${resp.status}`)
        throw new Error(`campaign ${action} failed: ${detail}`)
      }
      return await resp.json()
    },
  },
]
