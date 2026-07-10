import { describe, it, expect, vi } from 'vitest'
import { apply_beforeunload_guard, guard_close } from '$lib/structure/save-on-close'

describe('guard_close', () => {
  it('clean tab closes without prompting', async () => {
    const confirm = vi.fn()
    expect(await guard_close({ modified: false, on_save: vi.fn(), confirm })).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('save → runs save, closes when save succeeds', async () => {
    const on_save = vi.fn().mockResolvedValue(true)
    expect(await guard_close({ modified: true, on_save,
      confirm: async () => 'save' })).toBe(true)
    expect(on_save).toHaveBeenCalled()
  })
  it('save failure keeps the tab open', async () => {
    expect(await guard_close({ modified: true, on_save: async () => false,
      confirm: async () => 'save' })).toBe(false)
  })
  it('discard closes, cancel aborts', async () => {
    expect(await guard_close({ modified: true, on_save: vi.fn(),
      confirm: async () => 'discard' })).toBe(true)
    expect(await guard_close({ modified: true, on_save: vi.fn(),
      confirm: async () => 'cancel' })).toBe(false)
  })
})

describe('apply_beforeunload_guard', () => {
  it('clean state → does not block unload', () => {
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown }
    expect(apply_beforeunload_guard(event, false)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.returnValue).toBe(undefined)
  })
  it('modified → blocks unload (preventDefault + returnValue)', () => {
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown }
    expect(apply_beforeunload_guard(event, true)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.returnValue).toBe('')
  })
})
