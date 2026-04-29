import { describe, expect, test } from 'vitest'
import { markdown_to_html } from '$lib/chat/markdown'

describe(`markdown_to_html`, () => {
  test(`renders inline code`, () => {
    const result = markdown_to_html(`Use \`pnpm dev\` to start`)
    expect(result).toContain(`<code>pnpm dev</code>`)
  })

  test(`renders bold text`, () => {
    const result = markdown_to_html(`This is **bold** text`)
    expect(result).toContain(`<strong>bold</strong>`)
  })

  test(`renders italic text`, () => {
    const result = markdown_to_html(`This is *italic* text`)
    expect(result).toContain(`<em>italic</em>`)
  })

  test(`renders links`, () => {
    const result = markdown_to_html(`Visit [CatGO](https://example.com)`)
    expect(result).toContain(`<a href="https://example.com"`)
    expect(result).toContain(`>CatGO</a>`)
  })

  test(`renders fenced code blocks with copy button`, () => {
    const result = markdown_to_html('```python\nprint("hello")\n```')
    expect(result).toContain(`<pre><code`)
    // highlight.js wraps tokens in <span> tags, so check for the text content within spans
    expect(result).toContain(`print`)
    expect(result).toContain(`&quot;hello&quot;`)
    expect(result).toContain(`code-block-wrapper`)
    expect(result).toContain(`copy-code-btn`)
  })

  test(`renders code block with language label`, () => {
    const result = markdown_to_html('```bash\npnpm dev\n```')
    expect(result).toContain(`data-lang="bash"`)
    expect(result).toContain(`class="code-lang"`)
    expect(result).toContain(`bash`)
  })

  test(`renders unordered lists`, () => {
    const result = markdown_to_html(`- item one\n- item two\n- item three`)
    expect(result).toContain(`<ul>`)
    expect(result).toContain(`<li>item one</li>`)
    expect(result).toContain(`<li>item three</li>`)
  })

  test(`renders ordered lists`, () => {
    const result = markdown_to_html(`1. first\n2. second`)
    expect(result).toContain(`<ol>`)
    expect(result).toContain(`<li>first</li>`)
  })

  test(`escapes HTML entities`, () => {
    const result = markdown_to_html(`Use <script> tags carefully`)
    expect(result).toContain(`&lt;script&gt;`)
    expect(result).not.toContain(`<script>`)
  })

  test(`renders paragraphs`, () => {
    const result = markdown_to_html(`First paragraph.\n\nSecond paragraph.`)
    expect(result).toContain(`<p>First paragraph.</p>`)
    expect(result).toContain(`<p>Second paragraph.</p>`)
  })

  test(`handles empty string`, () => {
    expect(markdown_to_html(``)).toBe(``)
  })

  test(`renders headings`, () => {
    const result = markdown_to_html(`## Section Title`)
    expect(result).toContain(`<h4>Section Title</h4>`)
  })
})
