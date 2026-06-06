import { describe, it, expect } from 'vitest'
import { v2_monitor_ws_url } from '$lib/api/workflow-v2'

describe('v2_monitor_ws_url', () => {
  it('targets the engine router mount, not a /v2 alias', () => {
    const url = v2_monitor_ws_url('http://localhost:8000/api', 'wf_abc')
    expect(url).toBe('ws://localhost:8000/api/engine/workflows/wf_abc/monitor')
  })

  it('encodes the workflow id and converts https→wss', () => {
    const url = v2_monitor_ws_url('https://h:8000/api', 'a b:c')
    expect(url).toBe('wss://h:8000/api/engine/workflows/a%20b%3Ac/monitor')
  })
})
