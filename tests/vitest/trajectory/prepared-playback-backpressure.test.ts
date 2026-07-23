import { describe, expect, test } from 'vitest'
import {
  acknowledge_playback_frame,
  may_advance_playback,
  may_start_prepared_playback,
  request_playback_frame,
  type PreparedPlaybackState,
} from '$lib/trajectory/prepared-playback-state'

const initial = (): PreparedPlaybackState => ({
  requested_idx: 0,
  presented_idx: 0,
  generation: 0,
})

describe(`prepared playback backpressure`, () => {
  test(`timer cannot advance while a current request is unpresented`, () => {
    const requested = request_playback_frame(initial(), 1)
    expect(requested).toEqual({
      requested_idx: 1,
      presented_idx: 0,
      generation: 0,
    })
    expect(may_advance_playback(requested)).toBe(false)
  })

  test(`current acknowledgement advances presentation; obsolete acknowledgement is ignored`, () => {
    const requested = request_playback_frame(initial(), 1)
    expect(acknowledge_playback_frame(requested, 0)).toBe(requested)
    const acknowledged = acknowledge_playback_frame(requested, 1)
    expect(acknowledged.presented_idx).toBe(1)
    expect(may_advance_playback(acknowledged)).toBe(true)
  })

  test(`loop and direct scrub start a generation while sequential play does not`, () => {
    const sequential = request_playback_frame(initial(), 1)
    expect(sequential.generation).toBe(0)
    const scrub = request_playback_frame(sequential, 8)
    expect(scrub).toMatchObject({ requested_idx: 8, presented_idx: 0, generation: 1 })
    const loop = request_playback_frame({
      requested_idx: 99,
      presented_idx: 99,
      generation: 5,
    }, 0)
    expect(loop).toEqual({
      requested_idx: 0,
      presented_idx: 99,
      generation: 6,
    })
  })

  test(`start and resume require three prepared frames, or every smaller trajectory`, () => {
    expect(may_start_prepared_playback(0, 100)).toBe(false)
    expect(may_start_prepared_playback(2, 100)).toBe(false)
    expect(may_start_prepared_playback(3, 100)).toBe(true)
    expect(may_start_prepared_playback(1, 1)).toBe(true)
    expect(may_start_prepared_playback(1, 2)).toBe(false)
    expect(may_start_prepared_playback(2, 2)).toBe(true)
  })

  test(`single-frame, pause, and edit-stable states remain immediately usable`, () => {
    const state = initial()
    expect(may_advance_playback(state)).toBe(true)
    expect(acknowledge_playback_frame(state, 0)).toBe(state)
    expect(request_playback_frame(state, 0)).toBe(state)
  })
})
