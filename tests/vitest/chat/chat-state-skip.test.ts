import { describe, it, expect } from 'vitest'
import { get_chat_slice, new_session, resume_session, clear_chat_history } from '$lib/chat/chat-state.svelte'

describe('skip_permission slice state', () => {
  it('defaults false and is reset by new_session', () => {
    const s = get_chat_slice('t-skip')
    expect(s.skip_permission.value).toBe(false)
    s.skip_permission.value = true
    expect(get_chat_slice('t-skip').skip_permission.value).toBe(true)
    new_session(undefined, 't-skip')
    expect(get_chat_slice('t-skip').skip_permission.value).toBe(false)
  })

  it('resume_session clears skip_permission for the tab', () => {
    const tid = 't-skip-resume'
    get_chat_slice(tid).skip_permission.value = true
    resume_session('claude', 's1', undefined, tid)
    expect(get_chat_slice(tid).skip_permission.value).toBe(false)
  })

  it('clear_chat_history clears skip_permission for the tab', () => {
    const tid = 't-skip-clear'
    get_chat_slice(tid).skip_permission.value = true
    clear_chat_history(tid)
    expect(get_chat_slice(tid).skip_permission.value).toBe(false)
  })
})
