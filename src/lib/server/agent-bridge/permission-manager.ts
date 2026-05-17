import type { PermissionRequest, PermissionResult } from './types.js'

interface PendingEntry {
  request: PermissionRequest
  resolve: (result: PermissionResult) => void
  createdAt: number
}

const pending = new Map<string, PendingEntry>()

const STALE_MS = 10 * 60 * 1000

function cleanupStale(): void {
  const now = Date.now()
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > STALE_MS) {
      entry.resolve({ behavior: 'deny', message: 'Permission request timed out' })
      pending.delete(id)
    }
  }
}

export function registerPending(request: PermissionRequest): Promise<PermissionResult> {
  cleanupStale()
  return new Promise<PermissionResult>((resolve) => {
    pending.set(request.id, { request, resolve, createdAt: Date.now() })
  })
}

export function resolvePending(
  id: string,
  behavior: 'allow' | 'allow_session' | 'deny',
  suggestions?: unknown[],
  updatedInput?: Record<string, unknown>,
): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)

  if (behavior === 'deny') {
    entry.resolve({ behavior: 'deny', message: 'Denied by user' })
  } else {
    // For "allow_session", pass suggestions back as updatedPermissions.
    // The adapter's canUseTool will handle constructing a fallback rule
    // if suggestions are empty — see claude.ts.
    // `updatedInput` carries AskUserQuestion answers ({ questions, answers })
    // straight through to canUseTool.
    entry.resolve({
      behavior: 'allow',
      updatedPermissions: behavior === 'allow_session'
        ? (suggestions && suggestions.length > 0 ? suggestions : undefined)
        : undefined,
      updatedInput,
    })
  }
  return true
}

export function isPending(id: string): boolean {
  return pending.has(id)
}
