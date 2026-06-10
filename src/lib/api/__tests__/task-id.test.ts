import { describe, it, expect } from 'vitest'
import { is_valid_task_id } from '../task-adapter'

/**
 * Behavior tests for is_valid_task_id.
 *
 * Since #227 engine task ids are namespaced as `{workflow_id}:{node_id}`
 * (see server/catgo/workflow/task_ids.py) — e.g.
 * `885d5082-d3fd-4aaa-8dae-f75c9cf3b56b:n1781062668958-89a2`.
 * The validator must accept both the namespaced form and legacy bare ids,
 * otherwise the PENDING_REVIEW confirm/reject buttons dead-end with
 * "Invalid task ID" before the request is ever sent.
 */
describe('is_valid_task_id', () => {
  it('accepts namespaced engine task ids (workflow_id:node_id)', () => {
    expect(
      is_valid_task_id('885d5082-d3fd-4aaa-8dae-f75c9cf3b56b:n1781062668958-89a2')
    ).toBe(true)
  })

  it('accepts legacy bare task ids (no colon)', () => {
    expect(is_valid_task_id('n1780126181-5mj')).toBe(true)
    expect(is_valid_task_id('885d5082-d3fd-4aaa-8dae-f75c9cf3b56b')).toBe(true)
  })

  it('rejects null / undefined / non-strings', () => {
    expect(is_valid_task_id(null)).toBe(false)
    expect(is_valid_task_id(undefined)).toBe(false)
    expect(is_valid_task_id(42)).toBe(false)
  })

  it('rejects ids with path traversal or unsafe characters', () => {
    expect(is_valid_task_id('../../etc/passwd')).toBe(false)
    expect(is_valid_task_id('abc def ghi')).toBe(false)
    expect(is_valid_task_id('wf:node:extra:colons')).toBe(false)
    expect(is_valid_task_id('')).toBe(false)
  })

  it('rejects overlong ids', () => {
    expect(is_valid_task_id('a'.repeat(80))).toBe(false)
  })
})
