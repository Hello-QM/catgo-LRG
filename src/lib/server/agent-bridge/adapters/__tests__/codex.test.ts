import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent, PermissionResult, StreamParams } from '../../types.js'
import {
  buildCodexEnvironment,
  buildCodexMcpConfig,
  CODEX_CATGO_MCP_SERVER,
  createCodexAdapter,
  translateEvent,
} from '../codex.js'

const FAKE_CLI = resolve(__dirname, '../../../../../../tests/fixtures/fake-codex-cli.mjs')

function baseParams(over: Partial<StreamParams>): StreamParams {
  return {
    prompt: 'hello',
    permissionCallback: async (): Promise<PermissionResult> => ({ behavior: 'allow' }),
    ...over,
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of gen) out.push(event)
  return out
}

function translate(event: unknown): AgentEvent[] {
  return Array.from(translateEvent(event))
}

afterEach(() => {
  delete process.env.CATGO_CODEX_PATH
  delete process.env.CATGO_CODEX_TEST_ARGS_FILE
})

describe('codex adapter configuration composition', () => {
  it('injects the runtime backend URL into the Codex child environment', () => {
    const env = buildCodexEnvironment(
      'http://localhost:8002/api/mcp/',
      { PATH: '/usr/bin', CATGO_API: 'http://localhost:8000/api', UNSET: undefined },
    )

    expect(env).toEqual({
      PATH: '/usr/bin',
      CATGO_API: 'http://localhost:8002/api',
      CATGO_BACKEND_PORT: '8002',
    })
  })

  it('keeps the injected HTTP transport independent from a global stdio catgo server', () => {
    const globalServers = {
      catgo: {
        command: '/opt/catgo/bin/python',
        args: ['/opt/catgo/server.py'],
      },
    }
    const injected = buildCodexMcpConfig(
      'http://localhost:8002/api/mcp/',
      'structure-1',
    )
    const merged: Record<string, Record<string, unknown>> = {
      ...globalServers,
      catgo: { ...globalServers.catgo, ...injected.catgo },
      catgo_desktop: injected.catgo_desktop,
    }

    expect(CODEX_CATGO_MCP_SERVER).toBe('catgo_desktop')
    expect(merged.catgo).toEqual({ ...globalServers.catgo, enabled: false })
    expect(merged.catgo).not.toHaveProperty('url')
    expect(merged.catgo_desktop).toEqual({
      url: 'http://localhost:8002/api/mcp/',
      startup_timeout_sec: 20,
      http_headers: { 'X-CatGo-Tab-Id': 'structure-1' },
    })
    expect(merged.catgo_desktop).not.toHaveProperty('command')
  })

  it('preserves user config and injects the CatGo HTTP MCP under its own namespace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catgo-codex-adapter-'))
    const argsPath = join(dir, 'args.json')
    chmodSync(FAKE_CLI, 0o755)
    process.env.CATGO_CODEX_PATH = FAKE_CLI
    process.env.CATGO_CODEX_TEST_ARGS_FILE = argsPath

    const events = await collect(createCodexAdapter().stream(baseParams({
      mcpServerUrl: 'http://localhost:8002/api/mcp/',
      tabId: 'structure-1',
    })))
    const args = JSON.parse(readFileSync(argsPath, 'utf8')) as string[]

    expect(args.slice(0, 3)).toEqual([
      'exec',
      '--experimental-json',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(args).not.toContain('--ignore-user-config')
    expect(args).not.toContain('--model')
    expect(args).toContain('mcp_servers.catgo.enabled=false')
    expect(args).toContain('mcp_servers.catgo_desktop.url="http://localhost:8002/api/mcp/"')
    expect(args).toContain('mcp_servers.catgo_desktop.http_headers.X-CatGo-Tab-Id="structure-1"')
    expect(events.some((event) => event.type === 'result' && event.isError)).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('passes an explicitly selected discovered model to Codex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catgo-codex-adapter-'))
    const argsPath = join(dir, 'args.json')
    chmodSync(FAKE_CLI, 0o755)
    process.env.CATGO_CODEX_PATH = FAKE_CLI
    process.env.CATGO_CODEX_TEST_ARGS_FILE = argsPath

    await collect(createCodexAdapter().stream(baseParams({
      model: 'gpt-5.6-terra',
    })))
    const args = JSON.parse(readFileSync(argsPath, 'utf8')) as string[]
    const modelIndex = args.indexOf('--model')

    expect(modelIndex).toBeGreaterThanOrEqual(0)
    expect(args[modelIndex + 1]).toBe('gpt-5.6-terra')
  })
})

describe('codex SDK event translation', () => {
  it('does not terminate on a recoverable item-level error', () => {
    expect(translate({
      type: 'item.completed',
      item: {
        id: 'warning-1',
        type: 'error',
        message: 'Exceeded skills context budget',
      },
    })).toEqual([])
    expect(translate({
      type: 'item.completed',
      item: { id: 'message-1', type: 'agent_message', text: 'CATBOT_OK' },
    })).toEqual([{ type: 'text', text: 'CATBOT_OK' }])
    expect(translate({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 2 },
    })).toEqual([{
      type: 'result',
      isError: false,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 2,
      },
    }])
  })

  it.each([
    ['turn.failed', { type: 'turn.failed', error: { message: 'failed' } }, 'failed'],
    ['top-level error', { type: 'error', message: 'broken' }, 'broken'],
  ])('still terminates on %s', (_label, event, message) => {
    expect(translate(event)).toEqual([
      { type: 'result', isError: true, errorMessage: message },
      { type: 'done' },
    ])
  })
})
