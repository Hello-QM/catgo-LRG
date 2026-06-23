import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply_claude_settings_env,
  assistant_text_fallback,
  read_claude_settings_env,
} from '../claude.js'

const assistant = (blocks: unknown[]) => ({ type: 'assistant', message: { content: blocks } })

describe('assistant_text_fallback — text-loss guard for cold-start turns', () => {
  it('emits the final text blocks when NO partials streamed (len=0)', () => {
    const out = assistant_text_fallback(assistant([{ type: 'text', text: 'Hello!' }]), 0)
    expect(out).toEqual([{ type: 'text', text: 'Hello!' }])
  })

  it('returns [] when text already streamed (avoid duplication)', () => {
    const out = assistant_text_fallback(assistant([{ type: 'text', text: 'Hello!' }]), 6)
    expect(out).toEqual([])
  })

  it('returns [] when the assistant message has only tool_use (no text)', () => {
    const out = assistant_text_fallback(
      assistant([{ type: 'tool_use', id: 't1', name: 'x', input: {} }]),
      0,
    )
    expect(out).toEqual([])
  })

  it('emits multiple text blocks in order, skipping non-text blocks', () => {
    const out = assistant_text_fallback(
      assistant([
        { type: 'text', text: 'A' },
        { type: 'tool_use', id: 't', name: 'x', input: {} },
        { type: 'text', text: 'B' },
      ]),
      0,
    )
    expect(out).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }])
  })

  it('tolerates malformed / empty messages', () => {
    expect(assistant_text_fallback({ type: 'assistant' }, 0)).toEqual([])
    expect(assistant_text_fallback(null, 0)).toEqual([])
    expect(assistant_text_fallback(assistant([{ type: 'text', text: '' }]), 0)).toEqual([])
  })
})

describe('Claude settings env fallback', () => {
  function writeSettings(home: string, name: string, env: Record<string, string>): void {
    const dir = join(home, '.claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), JSON.stringify({ env }), 'utf8')
  }

  it('reads env from ~/.claude/settings.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'catgo-claude-env-'))
    writeSettings(home, 'settings.json', {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
    })

    expect(read_claude_settings_env(home)).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
    })
  })

  it('lets settings.local.json override settings.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'catgo-claude-env-'))
    writeSettings(home, 'settings.json', {
      ANTHROPIC_BASE_URL: 'http://old-proxy',
    })
    writeSettings(home, 'settings.local.json', {
      ANTHROPIC_BASE_URL: 'http://new-proxy',
    })

    expect(read_claude_settings_env(home).ANTHROPIC_BASE_URL).toBe('http://new-proxy')
  })

  it('fills missing process env without overriding explicit env', () => {
    const home = mkdtempSync(join(tmpdir(), 'catgo-claude-env-'))
    writeSettings(home, 'settings.json', {
      ANTHROPIC_BASE_URL: 'http://settings-proxy',
      ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
    })
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_BASE_URL: 'http://explicit-proxy',
    }

    expect(apply_claude_settings_env(env, home)).toEqual(['ANTHROPIC_AUTH_TOKEN'])
    expect(env.ANTHROPIC_BASE_URL).toBe('http://explicit-proxy')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('PROXY_MANAGED')
  })
})
