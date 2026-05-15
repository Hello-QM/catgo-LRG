#!/usr/bin/env node
/**
 * Fake `gemini --acp` CLI for tests. Speaks the minimal slice of the Agent
 * Client Protocol our adapter/pool/client use: newline-delimited JSON-RPC 2.0
 * over stdin/stdout.
 *
 * Behaviour is keyed off the prompt text so tests can drive scenarios:
 *   • "remember the number N"  → stores N in this process' memory
 *   • "what number ..."        → replies with the remembered N (proves the
 *                                process is reused across turns)
 *   • "PERMISSION"             → sends a server→client
 *                                session/request_permission and echoes the
 *                                picked optionId back as the reply text
 *   • "CRASH"                  → process.exit(1) without replying (simulates
 *                                an unexpected child crash mid-turn)
 *   • anything else            → replies "ok: <prompt>"
 *
 * The remembered number lives in module scope, so it survives multiple
 * session/prompt calls within one process but is gone if the process is
 * respawned — exactly the property the persistence + crash-reset tests check.
 */

import { createInterface } from 'node:readline'

let remembered = null
let sessionCounter = 0
let nextServerId = 10000
const permissionWaiters = new Map()

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function notifyText(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  })
}

async function handlePrompt(id, params) {
  const text = (params?.prompt ?? []).map((p) => p.text ?? '').join('')
  const sessionId = params?.sessionId

  const rememberMatch = text.match(/remember the number\s+(\d+)/i)
  if (rememberMatch) {
    remembered = rememberMatch[1]
    notifyText(sessionId, `Got it — ${remembered}.`)
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  if (/what number/i.test(text)) {
    notifyText(sessionId, remembered === null ? 'You have not told me a number.' : `The number is ${remembered}.`)
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  if (text.includes('PERMISSION')) {
    const sid = nextServerId++
    const picked = new Promise((resolve) => permissionWaiters.set(sid, resolve))
    send({
      jsonrpc: '2.0',
      id: sid,
      method: 'session/request_permission',
      params: {
        toolCall: { toolCallId: 'tc-1', title: 'danger_tool', input: {} },
        options: [
          { optionId: 'opt-allow', kind: 'allow_once' },
          { optionId: 'opt-deny', kind: 'reject_once' },
        ],
      },
    })
    const outcome = await picked
    const optionId = outcome?.outcome?.optionId ?? outcome?.outcome?.outcome ?? 'none'
    notifyText(sessionId, `permission picked: ${optionId}`)
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  if (text.includes('CRASH')) {
    // Die mid-turn without replying — client should reject the pending
    // session/prompt and the pool should flag a crash.
    process.exit(1)
  }

  notifyText(sessionId, `ok: ${text}`)
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }

  // Response to a server→client request (permission outcome).
  if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const w = permissionWaiters.get(msg.id)
    if (w) {
      permissionWaiters.delete(msg.id)
      w(msg.result)
    }
    return
  }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
    return
  }
  if (msg.method === 'session/new') {
    sessionCounter += 1
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sess-${sessionCounter}` } })
    return
  }
  if (msg.method === 'session/prompt') {
    void handlePrompt(msg.id, msg.params)
    return
  }
  if (msg.method === 'session/cancel') {
    // notification — no reply
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
})
