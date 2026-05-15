import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent, PermissionResult, StreamParams } from '../../types.js'
import { createGeminiAdapter, resetGeminiPoolForTests } from '../gemini.js'

const FAKE_CLI = resolve(__dirname, '../../../../../../tests/fixtures/fake-gemini-acp.mjs')

beforeAll(() => {
  process.env.CATGO_GEMINI_PATH = FAKE_CLI
})

afterEach(async () => {
  await resetGeminiPoolForTests()
})

function baseParams(over: Partial<StreamParams>): StreamParams {
  return {
    prompt: '',
    permissionCallback: async (): Promise<PermissionResult> => ({ behavior: 'allow' }),
    ...over,
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text)
    .join(' ')
}

describe('gemini adapter — persistent chatId', () => {
  it('keeps context across 3 sequential stream() calls with one chatId', async () => {
    const adapter = createGeminiAdapter()

    const turn1 = await collect(
      adapter.stream(baseParams({ chatId: 'tab-1', prompt: 'remember the number 7' })),
    )
    expect(turn1.at(-1)).toEqual({ type: 'done' })
    expect(turn1.some((e) => e.type === 'result' && e.isError)).toBe(false)

    const turn2 = await collect(
      adapter.stream(baseParams({ chatId: 'tab-1', prompt: 'what number did I tell you?' })),
    )
    expect(textOf(turn2)).toContain('7')

    const turn3 = await collect(
      adapter.stream(baseParams({ chatId: 'tab-1', prompt: 'remind me what number that was' })),
    )
    expect(textOf(turn3)).toContain('7')
  })

  it('one-shot path (no chatId) does NOT retain context', async () => {
    const adapter = createGeminiAdapter()

    await collect(adapter.stream(baseParams({ prompt: 'remember the number 9' })))
    const turn2 = await collect(adapter.stream(baseParams({ prompt: 'what number did I tell you?' })))
    // Fresh process per call → memory gone.
    expect(textOf(turn2)).not.toContain('9')
    expect(textOf(turn2).toLowerCase()).toContain('not told')
  })
})

describe('gemini adapter — permission optionId picked by kind', () => {
  it('allow → the option whose kind is allow_once', async () => {
    const adapter = createGeminiAdapter()
    const events = await collect(
      adapter.stream(
        baseParams({
          chatId: 'tab-perm-allow',
          prompt: 'PERMISSION test',
          permissionCallback: async () => ({ behavior: 'allow' }),
        }),
      ),
    )
    expect(textOf(events)).toContain('opt-allow')
  })

  it('deny → the option whose kind is reject_once', async () => {
    const adapter = createGeminiAdapter()
    const events = await collect(
      adapter.stream(
        baseParams({
          chatId: 'tab-perm-deny',
          prompt: 'PERMISSION test',
          permissionCallback: async () => ({ behavior: 'deny' }),
        }),
      ),
    )
    expect(textOf(events)).toContain('opt-deny')
  })
})
