import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CATGO_APPROVAL_ARG = '_catgo_approval_id'

function secretPath(): string {
  return process.env.CATGO_VERIFY_APPROVAL_SECRET_FILE
    || join(homedir(), '.catgo', 'verification-approval.key')
}

function approvalSecret(): string {
  const path = secretPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
  }
  const secret = readFileSync(path, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error('invalid CatGo verification approval secret')
  }
  try { chmodSync(path, 0o600) } catch { /* fail at request time if unreadable */ }
  return secret
}

function normalizedToolName(toolName: string): string {
  const marker = 'mcp__catgo__'
  return toolName.startsWith(marker) ? toolName.slice(marker.length) : toolName
}

export function isGuardedCatgoCall(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const tool = normalizedToolName(toolName)
  const action = String(input?.action ?? '').toLowerCase()
  if (tool === 'catgo_campaign' && action === 'report') return true
  return (
    ['catgo_workflow', 'catgo_workflow_engine', 'catgo_campaign'].includes(tool)
    && ['submit', 'run', 'execute', 'start', 'resume', 'retry'].includes(action)
  )
}

export function approvalId(input: Record<string, unknown>): string | undefined {
  const value = input?.[CATGO_APPROVAL_ARG]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function approveCatgoOverride(
  mcpServerUrl: string,
  challengeId: string,
  tabId?: string,
): Promise<void> {
  // A tab id is the same verification-session binding carried on MCP requests.
  // Without it the bridge cannot safely identify which ledger to approve.
  if (!tabId) throw new Error('CatGo verification approval requires a tab id')
  const endpoint = new URL('/api/system/verification/approve-override', mcpServerUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CatGo-Approval-Secret': approvalSecret(),
    },
    body: JSON.stringify({ approval_id: challengeId, tab_id: tabId }),
  })
  if (!response.ok) {
    throw new Error(`CatGo approval failed (${response.status})`)
  }
}
