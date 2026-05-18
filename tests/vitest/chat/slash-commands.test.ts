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

describe('/resume', () => {
  const sessions = [
    { session_id: 'sB', agent: 'claude', topic: 'OER on RuO2', created_at: 1, last_active: 200, message_count: 4 },
    { session_id: 'sA', agent: 'claude', topic: '', created_at: 1, last_active: 100, message_count: 2 },
  ]
  it('lists newest-first; shows topic + last-message snippet; falls back to last message when topic empty', async () => {
    const c = ctx({
      list_sessions: vi.fn(() => sessions),
      load_session_messages: vi.fn((id: string) =>
        id === 'sB' ? [{ role: 'user', content: 'hi', timestamp: 1 },
                        { role: 'assistant', content: 'Here is the OER workflow summary text', timestamp: 2 }]
                     : [{ role: 'user', content: 'plain question about slab', timestamp: 1 }]),
    })
    await run_slash('/resume', c as any)
    const out = (c.emit as any).mock.calls[0][0] as string
    expect(out.indexOf('1.')).toBeLessThan(out.indexOf('2.'))           // sB (newest) first
    expect(out).toContain('OER on RuO2 — Here is the OER workflow')     // topic + last-msg combined
    expect(out).toContain('plain question about slab')                  // empty topic → last msg
    expect(c.resume_session).not.toHaveBeenCalled()
  })
  it('shows only the topic when the session has no messages', async () => {
    const c = ctx({
      list_sessions: vi.fn(() => [{ session_id: 'sT', agent: 'claude', topic: 'Just a topic', created_at: 1, last_active: 5, message_count: 0 }]),
      load_session_messages: vi.fn(() => []),
    })
    await run_slash('/resume', c as any)
    const out = (c.emit as any).mock.calls[0][0] as string
    expect(out).toContain('Just a topic')
    // The session line must not have a separator — only the header line contains "—"
    const sessionLine = out.split('\n').find((l: string) => l.startsWith('1.')) ?? ''
    expect(sessionLine).not.toContain('—')   // no separator when there is no last message
  })
  it('numeric arg resumes the nth listed session', async () => {
    const c = ctx({
      list_sessions: vi.fn(() => sessions),
      load_session_messages: vi.fn(() => [{ role: 'user', content: 'x', timestamp: 1 }]),
    })
    await run_slash('/resume 1', c as any)
    expect(c.resume_session).toHaveBeenCalledWith('claude', 'sB',
      [{ role: 'user', content: 'x', timestamp: 1 }], 'default')
  })
  it('out-of-range index emits a usage note, does not throw or resume', async () => {
    const c = ctx({ list_sessions: vi.fn(() => sessions) })
    await run_slash('/resume 9', c as any)
    expect(c.resume_session).not.toHaveBeenCalled()
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('1–2'))
  })
  it('empty session list emits a note', async () => {
    const c = ctx({ list_sessions: vi.fn(() => []) })
    await run_slash('/resume', c as any)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('No past sessions'))
  })
  it('truncates a long composed line to 60 chars + ellipsis', async () => {
    const longTopic = 'X'.repeat(80)
    const c = ctx({
      list_sessions: vi.fn(() => [{ session_id: 's1', agent: 'claude', topic: longTopic, created_at: 1, last_active: 9, message_count: 0 }]),
      load_session_messages: vi.fn(() => []),
    })
    await run_slash('/resume', c as any)
    const out = (c.emit as any).mock.calls[0][0] as string
    const line = out.split('\n').find(l => l.startsWith('1.')) as string
    expect(line).toContain('…')
    expect(line).toContain('X'.repeat(60))
    expect(line).not.toContain('X'.repeat(61))
  })
})

describe('quickbuild commands', () => {
  it('/oer with no args calls run_quickbuild("OER", undefined)', async () => {
    const c = ctx(); await run_slash('/oer', c as any)
    expect(c.run_quickbuild).toHaveBeenCalledWith('OER', undefined)
  })
  it('/her mp-1019 passes the mp id', async () => {
    const c = ctx(); await run_slash('/her mp-1019', c as any)
    expect(c.run_quickbuild).toHaveBeenCalledWith('HER', 'mp-1019')
  })
  it('/co2rr and /nrr are registered', async () => {
    const c1 = ctx(); await run_slash('/co2rr', c1 as any)
    expect(c1.run_quickbuild).toHaveBeenCalledWith('CO2RR_2e', undefined)
    const c2 = ctx(); await run_slash('/nrr', c2 as any)
    expect(c2.run_quickbuild).toHaveBeenCalledWith('NRR', undefined)
  })
  it('rejects a malformed mp id with a usage note, no quickbuild call', async () => {
    const c = ctx(); await run_slash('/oer notanid', c as any)
    expect(c.run_quickbuild).not.toHaveBeenCalled()
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('mp-'))
  })
})

describe('/structure', () => {
  it('calls inject_structure', async () => {
    const c = ctx(); await run_slash('/structure', c as any)
    expect(c.inject_structure).toHaveBeenCalledTimes(1)
  })
})

describe('/skip-permission', () => {
  it('no arg reports current state', async () => {
    const c = ctx({ get_skip_permission: vi.fn(() => false) })
    await run_slash('/skip-permission', c as any)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('OFF'))
    expect(c.set_skip_permission).not.toHaveBeenCalled()
  })
  it('no arg reports ON when skip is enabled', async () => {
    const c = ctx({ get_skip_permission: vi.fn(() => true) })
    await run_slash('/skip-permission', c as any)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('ON'))
    expect(c.set_skip_permission).not.toHaveBeenCalled()
  })
  it('on sets true and emits a security warning', async () => {
    const c = ctx(); await run_slash('/skip-permission on', c as any)
    expect(c.set_skip_permission).toHaveBeenCalledWith(true)
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('⚠️'))
  })
  it('off sets false', async () => {
    const c = ctx(); await run_slash('/skip-permission off', c as any)
    expect(c.set_skip_permission).toHaveBeenCalledWith(false)
  })
  it('garbage arg emits usage, does not change state', async () => {
    const c = ctx(); await run_slash('/skip-permission maybe', c as any)
    expect(c.set_skip_permission).not.toHaveBeenCalled()
    expect(c.emit).toHaveBeenCalledWith(expect.stringContaining('on'))
  })
})
