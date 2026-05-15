import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GeminiProcessPool } from '../process-pool.js'

const FAKE_CLI = resolve(__dirname, '../../../../../../tests/fixtures/fake-gemini-acp.mjs')

beforeAll(() => {
  process.env.CATGO_GEMINI_PATH = FAKE_CLI
})

function prompt(handle: { client: any; sessionId: string }, text: string) {
  return handle.client.request('session/prompt', {
    sessionId: handle.sessionId,
    prompt: [{ type: 'text', text }],
  })
}

describe('GeminiProcessPool', () => {
  let pool: GeminiProcessPool

  afterEach(async () => {
    await pool.shutdown()
  })

  it('reuses one process for repeat chatId (cross-turn context)', async () => {
    pool = new GeminiProcessPool()

    const h1 = await pool.acquire('chat-A', {})
    const pid1 = h1.child.pid
    await prompt(h1, 'remember the number 7')
    pool.release(h1)

    const h2 = await pool.acquire('chat-A', {})
    expect(h2.child.pid).toBe(pid1) // same process
    expect(h2.sessionId).toBe(h1.sessionId) // same ACP session
    const res = await prompt(h2, 'what number did I tell you?')
    pool.release(h2)
    expect(res.stopReason).toBe('end_turn')
    expect(pool.size).toBe(1)
  })

  it('serializes concurrent acquires for one chatId FIFO', async () => {
    pool = new GeminiProcessPool()

    const order: number[] = []
    const h1 = await pool.acquire('chat-B', {})

    // Two more acquires while h1 is still held — must queue.
    const p2 = pool.acquire('chat-B', {}).then((h) => { order.push(2); return h })
    const p3 = pool.acquire('chat-B', {}).then((h) => { order.push(3); return h })

    // Neither resolves until h1 is released.
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual([])

    pool.release(h1)
    const h2 = await p2
    order.push(-1) // marker: h2 settled before we release it
    pool.release(h2)
    const h3 = await p3
    pool.release(h3)

    expect(order).toEqual([2, -1, 3])
    expect(h2.child.pid).toBe(h1.child.pid)
    expect(h3.child.pid).toBe(h1.child.pid)
  })

  it('respawns + flags crashedBefore after an unexpected exit', async () => {
    pool = new GeminiProcessPool()

    const h1 = await pool.acquire('chat-C', {})
    expect(h1.crashedBefore).toBe(false)
    const pid1 = h1.child.pid

    await expect(prompt(h1, 'CRASH now')).rejects.toThrow()
    pool.release(h1)

    // Give the exit listener a tick to record the crash + drop the entry.
    await new Promise((r) => setTimeout(r, 50))
    expect(pool.size).toBe(0)

    const h2 = await pool.acquire('chat-C', {})
    expect(h2.child.pid).not.toBe(pid1) // fresh process
    expect(h2.crashedBefore).toBe(true) // banner cue for the adapter
    pool.release(h2)
  })

  it('idle sweep evicts after the configured timeout', async () => {
    pool = new GeminiProcessPool(80 /* idleMs */, 20 /* sweepMs */)

    const h1 = await pool.acquire('chat-D', {})
    pool.release(h1)
    expect(pool.size).toBe(1)

    await new Promise((r) => setTimeout(r, 200))
    expect(pool.size).toBe(0)

    // A busy process is never swept.
    const h2 = await pool.acquire('chat-D', {})
    await new Promise((r) => setTimeout(r, 200))
    expect(pool.size).toBe(1)
    pool.release(h2)
  })
})
