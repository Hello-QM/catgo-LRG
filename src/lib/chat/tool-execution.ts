/**
 * Tool execution state helpers for ChatPane.
 *
 * Functions that inspect message lists for tool_use / tool_result blocks.
 */

import type { ChatMessage, ToolResultBlock } from './types'

/** Get tool_result blocks from the next message after an assistant message with tool_uses */
export function get_tool_results_for(messages: ChatMessage[], idx: number): ToolResultBlock[] {
  const next = messages[idx + 1]
  if (!next || typeof next.content === `string`) return []
  return next.content.filter((b): b is ToolResultBlock => b.type === `tool_result`)
}

/** Check if the message at `idx` is currently streaming */
export function is_streaming(
  idx: number,
  messages: ChatMessage[],
  loading: boolean,
): boolean {
  return (
    loading &&
    idx === messages.length - 1 &&
    messages[idx].role === `assistant`
  )
}

/** Get visible messages (excluding tool_result-only) for display */
export function get_visible_messages(
  messages: ChatMessage[],
  is_tool_result_msg: (msg: ChatMessage) => boolean,
): ChatMessage[] {
  return messages.filter((m) => !is_tool_result_msg(m))
}
