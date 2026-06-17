import { describe, it, expect, beforeEach } from 'vitest'
import { TERMINAL_TOOLS } from '../../src/lib/chat/terminal-tools'
import {
  register_terminal, _reset_registry_for_test, mark_terminal_active,
  type TerminalHandle,
} from '../../src/lib/structure/terminal-registry.svelte'

function find(name: string) {
  const t = TERMINAL_TOOLS.find((x) => x.def.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

const calls: string[] = []
function handle(): TerminalHandle {
  return {
    id: 'h', session_id: '', is_remote: false,
    run_command: async (cmd) => { calls.push('run:' + cmd); return { output: 'OUT', exit_code: 0, running: false } },
    send_keys: async (d) => { calls.push('keys:' + d) },
    interrupt: async () => { calls.push('interrupt') },
    read_buffer: () => 'BUFFER',
  }
}

describe('terminal tools', () => {
  beforeEach(() => { _reset_registry_for_test(); calls.length = 0; register_terminal(handle()); mark_terminal_active('h') })

  it('exposes the four tools with correct kinds', () => {
    expect(find('read_terminal').def.kind).toBe('read')
    expect(find('run_command').def.kind).toBe('mutate')
    expect(find('send_keys').def.kind).toBe('mutate')
    expect(find('interrupt_terminal').def.kind).toBe('mutate')
  })
  it('read_terminal returns the buffer', async () => {
    const r = await find('read_terminal').run({}) as { output: string }
    expect(r.output).toBe('BUFFER')
  })
  it('run_command forwards the command and returns output + exit_code', async () => {
    const r = await find('run_command').run({ command: 'pwd' }) as { output: string; exit_code: number }
    expect(calls).toContain('run:pwd')
    expect(r).toMatchObject({ output: 'OUT', exit_code: 0 })
  })
  it('send_keys resolves named keys before writing', async () => {
    await find('send_keys').run({ keys: 'y<enter>' })
    expect(calls).toContain('keys:y\r')
  })
  it('interrupt_terminal sends Ctrl-C', async () => {
    await find('interrupt_terminal').run({})
    expect(calls).toContain('interrupt')
  })
})
