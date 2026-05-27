import { describe, it, expect } from 'vitest'
import { markdown_to_html } from '../markdown'

/**
 * Regression tests for the markdown_to_html no-progress guard.
 *
 * Background: a CatBot reply crashed the app with
 *   `RangeError: Invalid array length at Array.push (markdown_to_html)`
 * caused by the main `while (idx < lines.length)` loop failing to advance
 * `idx` for some line pattern → the same line reprocessed forever → `out`
 * grew past ~2³² entries. The fix adds a belt-and-suspenders `_stuck_at`
 * guard that force-advances after detecting a non-progressing iteration.
 *
 * These tests assert termination (the function RETURNS rather than hanging /
 * throwing) and that output still contains the offending line's text, while a
 * normal-markdown sample proves there is no rendering regression.
 */

describe(`markdown_to_html — infinite-loop guard`, () => {
  it(`returns (does not hang/throw) on a lone pipe row that is not a valid table`, () => {
    const input = `Candidate matches incoming:\n|\nmore prose follows`
    const html = markdown_to_html(input)
    expect(typeof html).toBe(`string`)
    expect(html).toContain(`Candidate matches incoming`)
    expect(html).toContain(`more prose follows`)
  })

  it(`returns on a malformed / single-row table that never completes`, () => {
    const input = `| only one bar but no closing structure`
    const html = markdown_to_html(input)
    expect(typeof html).toBe(`string`)
    // The text content must survive in the output (escaped / wrapped).
    expect(html).toContain(`only one bar`)
  })

  it(`returns on decorative / DAG-trigger lines that an inner loop may not consume`, () => {
    // Box-drawing / tree characters that exercise the DAG + decorative branches.
    const input = `structure_input (RuO2) |\n├── slab (110)\n│\n└── done`
    const html = markdown_to_html(input)
    expect(typeof html).toBe(`string`)
    expect(html).toContain(`done`)
  })

  it(`returns on a pathological mix designed to stress every branch`, () => {
    const lines = [
      `intro text`,
      ``,
      `|`,
      `│`,
      `──`,
      `★`,
      `> `,
      `| a |`,
      `not a row`,
      `| b |`,
      `\\[`,
      `x^2`,
      // intentionally no closing \]
    ]
    // Repeat the block many times so any non-advancing branch would explode
    // `out` long before a sane timeout; the guard must keep it bounded.
    const input = Array.from({ length: 200 }, () => lines.join(`\n`)).join(`\n`)
    const html = markdown_to_html(input)
    expect(typeof html).toBe(`string`)
    expect(html.length).toBeLessThan(5_000_000)
    expect(html).toContain(`intro text`)
  })

  it(`force-emits escaped text for a genuinely stuck line without losing content`, () => {
    // A bare `|` line: the table branch consumes it, finds < 2 rows, and the
    // fallback emits it; the guard is the final safety net.
    const html = markdown_to_html(`|`)
    expect(typeof html).toBe(`string`)
    expect(html).toContain(`|`)
  })
})

describe(`markdown_to_html — no regression on normal markdown`, () => {
  it(`renders headings, lists, code fences and real tables correctly`, () => {
    const input = [
      `# Heading One`,
      ``,
      `Some **bold** and *italic* prose.`,
      ``,
      `- item one`,
      `- item two`,
      ``,
      `1. first`,
      `2. second`,
      ``,
      `| Material | Mismatch |`,
      `|---|---|`,
      `| MoS2 | 0.21 |`,
      `| WS2 | 1.8 |`,
      ``,
      `\`\`\`python`,
      `def f(x):`,
      `    return x + 1`,
      `\`\`\``,
    ].join(`\n`)

    const html = markdown_to_html(input)

    // Heading (level 1 markdown → h3 in this renderer's offset scheme)
    expect(html).toContain(`<h3>Heading One</h3>`)
    // Inline formatting
    expect(html).toContain(`<strong>bold</strong>`)
    expect(html).toContain(`<em>italic</em>`)
    // Lists
    expect(html).toContain(`<ul>`)
    expect(html).toContain(`<li>item one</li>`)
    expect(html).toContain(`<ol>`)
    expect(html).toContain(`<li>first</li>`)
    // Real table renders as a <table>
    expect(html).toContain(`<table>`)
    expect(html).toContain(`<th>Material</th>`)
    expect(html).toContain(`<td>MoS2</td>`)
    // Code fence renders as the code-block wrapper
    expect(html).toContain(`code-block-wrapper`)
    expect(html).toContain(`data-lang="python"`)
  })

  it(`renders a long code block with the collapse wrapper`, () => {
    const body = Array.from({ length: 30 }, (_, i) => `line_${i} = ${i}`).join(`\n`)
    const input = `\`\`\`python\n${body}\n\`\`\``
    const html = markdown_to_html(input)
    expect(html).toContain(`code-block-wrapper`)
    expect(html).toContain(`data-collapsed="true"`)
    expect(html).toContain(`Show all 30 lines`)
  })
})
