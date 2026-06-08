import { describe, expect, it } from 'vitest'
import { STATUS_COLORS } from '$lib/workflow/workflow-types'
import { normalize_status } from '$lib/api/task-adapter'

// Full V2 TaskState set that V2-native views (WorkflowDAGViewer, EngineTaskEditor)
// look up by their UPPERCASE enum value. STATUS_COLORS must carry a color for
// each so any state renders. (#224 Phase 3 prep)
const V2_TASK_STATES = [
  `WAITING`,
  `READY`,
  `GENERATING`,
  `UPLOADING`,
  `SUBMITTED`,
  `QUEUED`,
  `RUNNING`,
  `COMPLETED_REMOTE`,
  `COLLECTING`,
  `COMPLETED`,
  `FAILED`,
  `REMOTE_ERROR`,
  `PENDING_REVIEW`,
  `PAUSED`,
  `CANCELLED`,
] as const

// Existing V1 coarse strings — must still render (purely additive change).
const V1_COARSE_STATES = [
  `pending`,
  `queued`,
  `running`,
  `completed`,
  `not_converged`,
  `pending_review`,
  `failed`,
  `skipped`,
] as const

describe(`status vocabulary`, () => {
  it.each(V2_TASK_STATES)(`STATUS_COLORS carries V2 state %s`, (state) => {
    expect(STATUS_COLORS[state]).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  it.each(V1_COARSE_STATES)(`STATUS_COLORS still carries V1 coarse %s`, (state) => {
    expect(STATUS_COLORS[state]).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  it(`every V2 state collapses to a coarse string that has a color`, () => {
    for (const state of V2_TASK_STATES) {
      const coarse = normalize_status(state)
      expect(STATUS_COLORS[coarse]).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
})
