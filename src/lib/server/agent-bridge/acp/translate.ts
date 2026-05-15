/**
 * Pure ACP ⇄ AgentEvent translation helpers, extracted from the Gemini
 * adapter so the one-shot path and the persistent pool path share one
 * implementation (and so they're unit-testable without spawning a CLI).
 */

import type { AgentEvent } from '../types.js'

function extractText(content: any): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (content.type === 'text' && typeof content.text === 'string') return content.text
  if (Array.isArray(content)) return content.map(extractText).join('')
  return ''
}

/** Translate one ACP `session/update` payload into zero or more AgentEvents. */
export function translateUpdate(update: any): AgentEvent[] {
  const events: AgentEvent[] = []
  if (!update?.sessionUpdate) return events
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = extractText(update.content)
      if (text) events.push({ type: 'text', text })
      break
    }
    case 'agent_thought_chunk': {
      const text = extractText(update.content)
      if (text) events.push({ type: 'thinking', text })
      break
    }
    case 'tool_call':
      events.push({
        type: 'tool_start',
        toolId: String(update.toolCallId ?? ''),
        toolName: String(update.title ?? update.kind ?? ''),
        input: update.input ?? {},
      })
      break
    case 'tool_call_update': {
      const status = String(update.status ?? '')
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        const resultText = Array.isArray(update.content)
          ? update.content.map((c: any) => extractText(c.content ?? c)).join('\n')
          : extractText(update.content)
        events.push({
          type: 'tool_end',
          toolId: String(update.toolCallId ?? ''),
          toolName: String(update.title ?? ''),
          result: resultText,
          isError: status === 'failed',
        })
      }
      break
    }
    // plan / mode / command updates: not surfaced — UI doesn't render them.
    default:
      break
  }
  return events
}

/** The shape ACP expects back from a `session/request_permission` handler. */
export type PermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } }

/**
 * Map a user allow/deny decision onto an ACP `optionId`.
 *
 * `optionId` is a server-defined string (e.g. `proceed_once`, `allow-once`)
 * that varies between ACP agents — so we never hard-code it. Instead we pick
 * from the `options` array the agent sent with the request, matching by
 * standardized `kind`. Falls back to the first option (allow) or last option
 * (deny) when the agent uses non-standard kinds, and cancels the turn if the
 * agent sent no options at all (rather than hanging).
 */
export function mapPermissionRequest(
  rpcParams: any,
  behavior: 'allow' | 'deny',
): PermissionOutcome {
  const options: Array<{ optionId: string; kind?: string }> = Array.isArray(rpcParams?.options)
    ? rpcParams.options
    : []
  const wantKinds = behavior === 'allow'
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always']
  const match = options.find((o) => wantKinds.includes(String(o.kind ?? '')))
  if (match) {
    return { outcome: { outcome: 'selected', optionId: match.optionId } }
  }
  if (options.length > 0) {
    const fallback = behavior === 'allow' ? options[0] : options[options.length - 1]
    return { outcome: { outcome: 'selected', optionId: fallback.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}
