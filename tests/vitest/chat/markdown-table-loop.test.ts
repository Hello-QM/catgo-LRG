import { describe, it, expect } from 'vitest'
import { markdown_to_html } from '$lib/chat/markdown'

// Regression: a line that starts with `|` but does not yet form a full table
// (the common case mid-stream, when only a table's header row has arrived)
// used to revert `idx` and fall through to the paragraph branch, which
// explicitly skips `|`-leading lines. `idx` never advanced, the render loop
// spun forever pushing into `out`, and the main thread froze until
// `Array.push` threw "RangeError: Invalid array length". These tests pass only
// if markdown_to_html terminates.
describe('markdown_to_html table parsing (no infinite loop)', () => {
  it('terminates on a lone table row (mid-stream)', () => {
    const html = markdown_to_html(`| 参数 | 数值 |`)
    expect(typeof html).toBe(`string`)
    expect(html.length).toBeGreaterThan(0)
  })

  it('terminates on header + separator with no body rows', () => {
    const html = markdown_to_html(`| 参数 | 数值 |\n|------|------|`)
    expect(typeof html).toBe(`string`)
  })

  it('terminates on a lone row followed by normal text', () => {
    const html = markdown_to_html(`| only one row |\n\nsome paragraph text`)
    expect(html).toContain(`some paragraph text`)
  })

  it('still renders a complete table', () => {
    const html = markdown_to_html(
      `| 参数 | 数值 |\n|------|------|\n| 直径 | 5.14 Å |\n| 原子数 | 90 |`,
    )
    expect(html).toContain(`<table>`)
    expect(html).toContain(`<td>`)
    expect(html).toContain(`5.14`)
  })
})
