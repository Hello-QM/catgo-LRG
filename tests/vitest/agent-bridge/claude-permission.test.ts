import { describe, it, expect } from 'vitest'
import { decide_tool_permission } from '$lib/server/agent-bridge/adapters/claude'

describe('decide_tool_permission (security gate)', () => {
  it('always allows CatGo MCP tools regardless of skipPermissions', () => {
    expect(decide_tool_permission('mcp__catgo__catgo_workflow', false)).toBe('allow')
    expect(decide_tool_permission('catgo_structure', undefined)).toBe('allow')
    expect(decide_tool_permission('mcp__catgo__x', true)).toBe('allow')
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
