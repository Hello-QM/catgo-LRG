import { describe, it, expect, vi } from 'vitest'
import { match_slash, run_slash, SLASH_COMMANDS } from '$lib/chat/slash-commands'

function ctx(over = {}) {
  return {
    tab_id: 'default', args: '',
    new_session: vi.fn(), clear_chat_history: vi.fn(), cancel_generation: vi.fn(),
    resume_session: vi.fn(), list_sessions: vi.fn(() => []), load_session_messages: vi.fn(() => []),
    run_quickbuild: vi.fn(async () => {}), inject_structure: vi.fn(async () => {}),
    set_skip_permission: vi.fn(), get_skip_permission: vi.fn(() => false),
    emit: vi.fn(),
    ...over,
  }
}

describe('match_slash', () => {
  it('returns null for non-slash', () => {
    expect(match_slash('hello')).toBeNull()
    expect(match_slash('  hi /new')).toBeNull()
  })
  it('matches command name case-insensitively with args', () => {
    const m = match_slash('/HELP extra args')
    expect(m?.cmd.name).toBe('help')
    expect(m?.args).toBe('extra args')
  })
  it('matches with no args and trims', () => {
    const m = match_slash('  /help  ')
    expect(m?.cmd.name).toBe('help')
    expect(m?.args).toBe('')
  })
  it('returns null for unknown slash token', () => {
    expect(match_slash('/bogus')).toBeNull()
  })
  it('first token resolves to the help command', () => {
    const m = match_slash('/HELP')
    expect(m?.cmd.name).toBe('help')
  })
})

describe('run_slash', () => {
  it('returns false when not a command (no UI side effects)', async () => {
    const c = ctx()
    expect(await run_slash('plain text', c as any)).toBe(false)
    expect(c.emit).not.toHaveBeenCalled()
  })
  it('emits unknown-command help hint for unmatched slash', async () => {
    const c = ctx()
    expect(await run_slash('/nope', c as any)).toBe(true)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('/help'))
  })
  it('/help lists every registered command', async () => {
    const c = ctx()
    await run_slash('/help', c as any)
    const out = (c.emit as any).mock.calls[0][0] as string
    for (const cmd of SLASH_COMMANDS) expect(out).toContain('/' + cmd.name)
    expect(out).toContain('List all slash commands') // real help body, not an error string
    expect(out).not.toContain('failed')
  })
  it('emits error message when a command throws', async () => {
    SLASH_COMMANDS.push({ name: '__test_throw', hint: '', summary: 'x',
      run() { throw new Error('boom') } })
    const c = ctx()
    await run_slash('/__test_throw', c as any)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('boom'))
    const i = SLASH_COMMANDS.findIndex(x => x.name === '__test_throw')
    SLASH_COMMANDS.splice(i, 1)
  })
})

describe('session commands', () => {
  it('/new calls new_session', async () => {
    const c = ctx(); await run_slash('/new', c as any)
    expect(c.new_session).toHaveBeenCalledTimes(1)
  })
  it('/clear calls clear_chat_history', async () => {
    const c = ctx(); await run_slash('/clear', c as any)
    expect(c.clear_chat_history).toHaveBeenCalledTimes(1)
  })
  it('/stop calls cancel_generation', async () => {
    const c = ctx(); await run_slash('/stop', c as any)
    expect(c.cancel_generation).toHaveBeenCalledTimes(1)
  })
})
