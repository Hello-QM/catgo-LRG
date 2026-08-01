import { describe, it, expect } from 'vitest'
import { decide_tool_permission } from '$lib/server/agent-bridge/adapters/claude'

describe('decide_tool_permission (security gate)', () => {
  it('allows ordinary CatGo tools and guarded preflight calls', () => {
    expect(decide_tool_permission('mcp__catgo__catgo_workflow', false)).toBe('allow')
    expect(decide_tool_permission(
      'mcp__catgo__catgo_workflow', false, { action: 'submit' },
    )).toBe('allow')
    expect(decide_tool_permission('catgo_structure', undefined)).toBe('allow')
    expect(decide_tool_permission('mcp__catgo__x', true)).toBe('allow')
  })
  it('always gates a guarded retry carrying an approval challenge', () => {
    const input = { action: 'submit', _catgo_approval_id: 'visible-challenge' }
    expect(decide_tool_permission('mcp__catgo__catgo_workflow', false, input)).toBe('gate')
    expect(decide_tool_permission('mcp__catgo__catgo_workflow', true, input)).toBe('gate')
    expect(decide_tool_permission(
      'catgo_campaign', true, { action: 'report', _catgo_approval_id: 'challenge' },
    )).toBe('gate')
  })
  it('gates non-CatGo tools when skipPermissions is not exactly true', () => {
    expect(decide_tool_permission('Bash', false)).toBe('gate')
    expect(decide_tool_permission('Bash', undefined)).toBe('gate')
    // truthy-but-not-true must NOT escalate
    expect(decide_tool_permission('Bash', 1 as unknown as boolean)).toBe('gate')
    expect(decide_tool_permission('Bash', 'true' as unknown as boolean)).toBe('gate')
  })
  it('allows non-CatGo tools only when skipPermissions === true', () => {
    expect(decide_tool_permission('Bash', true)).toBe('allow')
    expect(decide_tool_permission('Write', true)).toBe('allow')
  })
})
