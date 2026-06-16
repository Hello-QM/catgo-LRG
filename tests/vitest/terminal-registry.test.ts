import { describe, it, expect, beforeEach } from 'vitest'
import {
  register_terminal, unregister_terminal, mark_terminal_active,
  get_active_terminal, has_active_terminal, _reset_registry_for_test,
  type TerminalHandle,
} from '../../src/lib/structure/terminal-registry.svelte'

function fake(id: string): TerminalHandle {
  return {
    id, session_id: '', is_remote: false,
    run_command: async () => ({ output: '', exit_code: 0, running: false }),
    send_keys: async () => {}, interrupt: async () => {}, read_buffer: () => '',
  }
}

describe('terminal-registry', () => {
  beforeEach(() => _reset_registry_for_test())

  it('reports no active terminal when empty', () => {
    expect(has_active_terminal()).toBe(false)
    expect(get_active_terminal()).toBeNull()
  })
  it('returns the explicitly-activated handle', () => {
    register_terminal(fake('a')); register_terminal(fake('b'))
    mark_terminal_active('b')
    expect(get_active_terminal()?.id).toBe('b')
  })
  it('falls back to the most-recently registered when active id is stale', () => {
    register_terminal(fake('a')); register_terminal(fake('b'))
    mark_terminal_active('b')
    unregister_terminal('b')
    expect(get_active_terminal()?.id).toBe('a')
  })
  it('unregister of a non-active handle keeps the active one', () => {
    register_terminal(fake('a')); register_terminal(fake('b'))
    mark_terminal_active('a')
    unregister_terminal('b')
    expect(get_active_terminal()?.id).toBe('a')
  })
})
