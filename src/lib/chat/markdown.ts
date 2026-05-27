/**
 * Lightweight markdown → HTML renderer for chat messages.
 * Handles: fenced code blocks (with syntax highlighting), inline code,
 * bold, italic, links, lists, blockquotes, tables, paragraphs.
 */

import katex from 'katex'
import 'katex/dist/katex.min.css'
import hljs from 'highlight.js/lib/core'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import bash_lang from 'highlight.js/lib/languages/bash'
import json_lang from 'highlight.js/lib/languages/json'
import yaml_lang from 'highlight.js/lib/languages/yaml'
import xml_lang from 'highlight.js/lib/languages/xml'
import css_lang from 'highlight.js/lib/languages/css'
import cpp from 'highlight.js/lib/languages/cpp'
import go_lang from 'highlight.js/lib/languages/go'
import rust_lang from 'highlight.js/lib/languages/rust'

hljs.registerLanguage(`python`, python)
hljs.registerLanguage(`javascript`, javascript)
hljs.registerLanguage(`js`, javascript)
hljs.registerLanguage(`typescript`, typescript)
hljs.registerLanguage(`ts`, typescript)
hljs.registerLanguage(`bash`, bash_lang)
hljs.registerLanguage(`shell`, bash_lang)
hljs.registerLanguage(`sh`, bash_lang)
hljs.registerLanguage(`json`, json_lang)
hljs.registerLanguage(`yaml`, yaml_lang)
hljs.registerLanguage(`yml`, yaml_lang)
hljs.registerLanguage(`html`, xml_lang)
hljs.registerLanguage(`xml`, xml_lang)
hljs.registerLanguage(`css`, css_lang)
hljs.registerLanguage(`cpp`, cpp)
hljs.registerLanguage(`c`, cpp)
hljs.registerLanguage(`go`, go_lang)
hljs.registerLanguage(`rust`, rust_lang)

/** Escape HTML entities */
function esc(str: string): string {
  return str
    .replace(/&/g, `&amp;`)
    .replace(/</g, `&lt;`)
    .replace(/>/g, `&gt;`)
    .replace(/"/g, `&quot;`)
}

/** Reverse HTML escaping so KaTeX receives raw LaTeX */
function html_unescape(text: string): string {
  return text
    .replace(/&amp;/g, `&`)
    .replace(/&lt;/g, `<`)
    .replace(/&gt;/g, `>`)
    .replace(/&quot;/g, `"`)
}

/** Render LaTeX math to HTML via KaTeX, falling back to escaped text on error */
function render_math(tex: string, display_mode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display_mode, throwOnError: false })
  } catch {
    return `<code>${esc(tex)}</code>`
  }
}

/** Render inline markdown (bold, italic, code, math, links) */
function render_inline(text: string): string {
  return text
    // inline code (must come first to protect contents from math/bold)
    .replace(/`([^`]+)`/g, `<code>$1</code>`)
    // display math $$...$$ (before inline $ to avoid partial match)
    .replace(/\$\$(.+?)\$\$/g, (_, tex) => render_math(html_unescape(tex), true))
    // inline math $...$ (not preceded/followed by $, content not empty/whitespace-only)
    .replace(/(?<!\$)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g, (_, tex) => render_math(html_unescape(tex), false))
    // \(...\) inline math
    .replace(/\\\((.+?)\\\)/g, (_, tex) => render_math(html_unescape(tex), false))
    // \[...\] display math (single-line)
    .replace(/\\\[(.+?)\\\]/g, (_, tex) => render_math(html_unescape(tex), true))
    // Markdown backslash escapes: \* \_ \\ \` \[ \] \( \) \# \+ \- \. \! \|
    // Convert to HTML entities so they render as literal chars and don't trigger markdown syntax
    .replace(/\\([\\*_`\[\]()#+\-.!|])/g, (_, ch) => `&#${ch.charCodeAt(0)};`)
    // bold+italic
    .replace(/\*\*\*(.+?)\*\*\*/g, `<strong><em>$1</em></strong>`)
    // bold
    .replace(/\*\*(.+?)\*\*/g, `<strong>$1</strong>`)
    // italic
    .replace(/\*(.+?)\*/g, `<em>$1</em>`)
    // images (must come before links to avoid `![alt](url)` being parsed as `!` + link)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, `<img src="$2" alt="$1" loading="lazy" />`)
    // links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`)
}

/** Syntax-highlight code, falling back to escaped plain text */
function highlight_code(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      // fall through
    }
  }
  return esc(code)
}

/** Collapse threshold for long code blocks */
const CODE_COLLAPSE_LINES = 20
const CODE_PREVIEW_LINES = 15

/** Convert markdown string to sanitized HTML */
/** Lines that are purely decorative box-drawing characters — no letters or digits */
const DECORATIVE_LINE_RE = /^[─━═╌╍┄┅┈┉╴╶╸╺│┃┆┇┊┋╎╏\s`]+$/
/** Lines that look like DAG/tree structure — contain tree-drawing chars mixed with text */
const DAG_LINE_RE = /[├└│┌┐┘┬┴┼╔╗╚╝╠╣╦╩╬]|──[→►>]|[→►>]──/

export function markdown_to_html(md: string): string {
  // Protect fenced code blocks before decorative cleaning —
  // box-drawing chars in code blocks (DAG diagrams, ASCII art) must be preserved
  const code_blocks: string[] = []
  let protected_md = md.replace(/```[\s\S]*?```/g, (match) => {
    code_blocks.push(match)
    return `\x00CB${code_blocks.length - 1}\x00`
  })

  // Pre-process: strip tool call text and decorative borders from raw markdown
  // These can appear inline (glued to previous text) so line-based matching isn't enough
  let cleaned = protected_md
    // Remove "> Calling `tool`..." patterns (shown in activity bar instead)
    .replace(/>?\s*Calling\s+`?\w+`?\s*\.\.\.\s*/g, ``)
    // Remove backtick-wrapped decorative lines: `─────────────` → empty
    .replace(/`[─━═╌╍┄┅┈┉╴╶╸╺│┃┆┇┊┋╎╏\s]{3,}`/g, ``)
    // Convert backtick-wrapped insight headers: `★ Insight ─────` → ★ Insight
    .replace(/`([★☆]\s*\w[\w\s]*?)\s*[─━═]*\s*`/g, `\n$1\n`)
    // Remove remaining decorative box-drawing runs (5+ consecutive chars)
    // but NOT on lines that look like DAG/tree diagrams
    .split(`\n`).map(l => DAG_LINE_RE.test(l) ? l : l.replace(/[─━═╌╍┄┅┈┉╴╶╸╺│┃┆┇┊┋╎╏]{5,}/g, ``)).join(`\n`)

  // Restore protected code blocks
  cleaned = cleaned.replace(/\x00CB(\d+)\x00/g, (_, i) => code_blocks[Number(i)])

  const lines = cleaned.split(`\n`)
  const out: string[] = []
  let idx = 0

  // No-progress guard (belt-and-suspenders): every branch below is expected to
  // advance `idx` by ≥1. If any branch ever leaves `idx` unchanged (e.g. an
  // inner consume-loop captured zero lines while its `continue` skips the
  // normal fall-through), the same line would be reprocessed forever and `out`
  // would grow until `Array.push` throws "RangeError: Invalid array length",
  // crashing the whole app. This guard detects a repeated `idx` and force-emits
  // the offending line as escaped text, guaranteeing termination for ANY input.
  let _stuck_at = -1

  while (idx < lines.length) {
    if (idx === _stuck_at) {
      // Same line as the previous iteration → a branch failed to advance idx.
      // Emit the raw (escaped) line and force progress.
      out.push(esc(lines[idx]))
      idx++
      _stuck_at = -1
      continue
    }
    _stuck_at = idx

    const line = lines[idx]

    // Skip empty lines that were left after stripping (but keep intentional blank lines)
    // Only skip if the line is purely whitespace/backticks after cleaning
    if (DECORATIVE_LINE_RE.test(line.trim()) && line.trim().length > 0) {
      idx++
      continue
    }

    // Convert "★ Insight" style headers to clean styled divs
    // After pre-processing, the ─── part is stripped, so match with or without it
    const insight_match = line.match(/^`?[★☆]\s*(.+?)\s*[─━═]*\s*`?$/)
    if (insight_match && insight_match[1].trim()) {
      out.push(`<div class="insight-header">${insight_match[1].trim().replace(/</g, `&lt;`).replace(/>/g, `&gt;`)}</div>`)
      idx++
      continue
    }

    // Block math $$...$$
    if (line.startsWith(`$$`)) {
      const single_line = line.match(/^\$\$(.+)\$\$$/)
      if (single_line) {
        out.push(render_math(single_line[1].trim(), true))
        idx++
        continue
      }
      // Multi-line block math
      const math_lines: string[] = []
      idx++
      while (idx < lines.length && !lines[idx].startsWith(`$$`)) {
        math_lines.push(lines[idx])
        idx++
      }
      idx++ // skip closing $$
      out.push(render_math(math_lines.join(`\n`), true))
      continue
    }

    // Block math \[...\]
    if (line.trimEnd() === `\\[`) {
      const math_lines: string[] = []
      idx++
      while (idx < lines.length && lines[idx].trimEnd() !== `\\]`) {
        math_lines.push(lines[idx])
        idx++
      }
      idx++ // skip closing \]
      out.push(render_math(math_lines.join(`\n`), true))
      continue
    }

    // Auto-detect DAG/tree diagrams — consecutive lines with tree-drawing chars
    // Wrap them in <pre> to preserve formatting and prevent markdown interpretation
    if (DAG_LINE_RE.test(line)) {
      const dag_lines: string[] = []
      while (idx < lines.length && (DAG_LINE_RE.test(lines[idx]) || (DECORATIVE_LINE_RE.test(lines[idx].trim()) && lines[idx].trim().length > 0))) {
        dag_lines.push(lines[idx].replace(/</g, `&lt;`).replace(/>/g, `&gt;`))
        idx++
      }
      // Include the preceding line if it looks like a DAG root (e.g. "structure_input (RuO₂) |")
      // or if the previous output is a single-line <p> that is likely the tree root label
      if (out.length > 0) {
        const prev_raw = out[out.length - 1].replace(/<[^>]*>/g, ``)
        const is_pipe_ending = /[|│┃]\s*$/.test(prev_raw)
        const is_single_line_p = /^<p>[^<]*<\/p>$/.test(out[out.length - 1]) && dag_lines.length > 0 && /^[└├│┌]/.test(dag_lines[0].replace(/&lt;/g, `<`).replace(/&gt;/g, `>`).trim())
        if (is_pipe_ending || is_single_line_p) {
          const prev = out.pop()!
          const prev_text = prev.replace(/<[^>]*>/g, ``).replace(/&lt;/g, `<`).replace(/&gt;/g, `>`)
          dag_lines.unshift(prev_text.replace(/</g, `&lt;`).replace(/>/g, `&gt;`))
        }
      }
      out.push(`<pre class="dag-diagram">${dag_lines.join(`\n`)}</pre>`)
      continue
    }

    // Fenced code block
    const fence_match = line.match(/^```(\w*)/)
    if (fence_match) {
      const lang = fence_match[1]
      const code_lines: string[] = []
      idx++
      while (idx < lines.length && !lines[idx].startsWith(`\`\`\``)) {
        code_lines.push(lines[idx])
        idx++
      }
      idx++ // skip closing ```
      const lang_attr = lang ? ` data-lang="${esc(lang)}"` : ``
      const lang_label = lang ? `<span class="code-lang">${esc(lang)}</span>` : ``
      const copy_btn = `<button type="button" class="copy-code-btn" title="Copy code">Copy</button>`

      const line_count = code_lines.length
      if (line_count > CODE_COLLAPSE_LINES) {
        const preview = highlight_code(code_lines.slice(0, CODE_PREVIEW_LINES).join(`\n`), lang)
        const full = highlight_code(code_lines.join(`\n`), lang)
        out.push(
          `<div class="code-block-wrapper" data-collapsed="true" data-lines="${line_count}">`
          + `${lang_label}${copy_btn}`
          + `<pre class="code-preview"><code${lang_attr}>${preview}</code></pre>`
          + `<pre class="code-full" style="display:none"><code${lang_attr}>${full}</code></pre>`
          + `<button type="button" class="code-expand-btn">Show all ${line_count} lines</button>`
          + `</div>`,
        )
      } else {
        const highlighted = highlight_code(code_lines.join(`\n`), lang)
        out.push(
          `<div class="code-block-wrapper">${lang_label}${copy_btn}`
          + `<pre><code${lang_attr}>${highlighted}</code></pre></div>`,
        )
      }
      continue
    }

    // Blockquote
    if (line.startsWith(`> `)) {
      const quote_lines: string[] = []
      while (idx < lines.length && lines[idx].startsWith(`> `)) {
        quote_lines.push(render_inline(esc(lines[idx].slice(2))))
        idx++
      }
      out.push(`<blockquote>${quote_lines.join(`<br>`)}</blockquote>`)
      continue
    }

    // Table: detect | col | col | pattern
    if (line.includes(`|`) && line.trim().startsWith(`|`)) {
      const table_lines: string[] = []
      while (idx < lines.length && lines[idx].includes(`|`) && lines[idx].trim().startsWith(`|`)) {
        table_lines.push(lines[idx])
        idx++
      }
      if (table_lines.length >= 2) {
        const parse_row = (row: string) => row.split(`|`).slice(1, -1).map((c) => c.trim())
        const headers = parse_row(table_lines[0])
        const data_start = table_lines[1].match(/^\|[\s\-:|]+\|$/) ? 2 : 1
        const rows = table_lines.slice(data_start).map(parse_row)

        let html = `<table><thead><tr>${headers.map((h) => `<th>${render_inline(esc(h))}</th>`).join(``)}</tr></thead><tbody>`
        for (const row of rows) {
          html += `<tr>${row.map((c) => `<td>${render_inline(esc(c))}</td>`).join(``)}</tr>`
        }
        html += `</tbody></table>`
        out.push(html)
        continue
      }
      // Not a valid table yet — typically a lone `|` row that arrives mid-stream
      // before the rest of the table. Render the consumed line(s) as a paragraph
      // and DO NOT revert idx: the paragraph fallback below skips `|`-leading
      // lines, so reverting would leave idx unadvanced and spin this outer loop
      // forever (out grows until `Array.push` throws "Invalid array length").
      out.push(`<p>${render_inline(esc(table_lines.join(`\n`)))}</p>`)
      continue
    }

    // Headings
    const heading_match = line.match(/^(#{1,4})\s+(.+)/)
    if (heading_match) {
      const level = heading_match[1].length
      out.push(`<h${level + 2}>${render_inline(esc(heading_match[2]))}</h${level + 2}>`)
      idx++
      continue
    }

    // Unordered list items
    if (line.match(/^\s*[-*]\s/)) {
      const items: string[] = []
      while (idx < lines.length && lines[idx].match(/^\s*[-*]\s/)) {
        items.push(render_inline(esc(lines[idx].replace(/^\s*[-*]\s/, ``))))
        idx++
      }
      out.push(`<ul>${items.map((i) => `<li>${i}</li>`).join(``)}</ul>`)
      continue
    }

    // Ordered list items
    if (line.match(/^\s*\d+\.\s/)) {
      const items: string[] = []
      while (idx < lines.length && lines[idx].match(/^\s*\d+\.\s/)) {
        items.push(render_inline(esc(lines[idx].replace(/^\s*\d+\.\s/, ``))))
        idx++
      }
      out.push(`<ol>${items.map((i) => `<li>${i}</li>`).join(``)}</ol>`)
      continue
    }

    // Horizontal rule
    if (line.match(/^(-{3,}|\*{3,}|_{3,})\s*$/)) {
      out.push(`<hr>`)
      idx++
      continue
    }

    // Blank line
    if (!line.trim()) {
      idx++
      continue
    }

    // Regular paragraph — collect consecutive non-blank, non-special lines
    const para_lines: string[] = []
    while (
      idx < lines.length &&
      lines[idx].trim() &&
      !lines[idx].startsWith(`$$`) &&
      !lines[idx].match(/^```/) &&
      !lines[idx].match(/^#{1,4}\s/) &&
      !lines[idx].match(/^\s*[-*]\s/) &&
      !lines[idx].match(/^\s*\d+\.\s/) &&
      !lines[idx].startsWith(`> `) &&
      !(lines[idx].includes(`|`) && lines[idx].trim().startsWith(`|`)) &&
      !DAG_LINE_RE.test(lines[idx]) &&
      !(DECORATIVE_LINE_RE.test(lines[idx].trim()) && lines[idx].trim().length > 0)
    ) {
      para_lines.push(lines[idx])
      idx++
    }
    out.push(`<p>${render_inline(esc(para_lines.join(`\n`)))}</p>`)
  }

  return out.join(`\n`)
}
