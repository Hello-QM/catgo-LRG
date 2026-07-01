/**
 * Full GitHub-flavoured markdown → sanitized HTML for the DOC VIEWER (README and
 * other `.md`/`.rst` files). Unlike `$lib/chat/markdown` — a line-based renderer
 * tuned for chat messages that escapes raw HTML and strips decorative borders —
 * this uses markdown-it with `html: true` so README constructs (`<p align="center">`,
 * `<img>`, shields/badges, `<a>`, tables) render like they do on GitHub. Output is
 * DOMPurify-sanitized, so raw HTML is safe even for untrusted files.
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash_lang from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import css_lang from 'highlight.js/lib/languages/css'
import go_lang from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json_lang from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import rust_lang from 'highlight.js/lib/languages/rust'
import typescript from 'highlight.js/lib/languages/typescript'
import xml_lang from 'highlight.js/lib/languages/xml'
import yaml_lang from 'highlight.js/lib/languages/yaml'
import 'highlight.js/styles/github.css'

// hljs is a shared singleton; registration is idempotent-guarded so this is safe
// even if another module already registered the same languages.
const LANGS: Array<[string, unknown]> = [
  [`bash`, bash_lang], [`cpp`, cpp], [`css`, css_lang], [`go`, go_lang],
  [`javascript`, javascript], [`json`, json_lang], [`python`, python],
  [`rust`, rust_lang], [`typescript`, typescript], [`xml`, xml_lang], [`yaml`, yaml_lang],
]
for (const [name, lang] of LANGS) {
  try {
    if (!hljs.getLanguage(name)) hljs.registerLanguage(name, lang as never)
  } catch { /* ignore double-registration */ }
}

const md: MarkdownIt = new MarkdownIt({
  html: true, // render raw HTML blocks/inline (README badges, centered images…)
  linkify: true, // autolink bare URLs
  typographer: true,
  breaks: false, // GitHub does NOT turn single newlines into <br>
  highlight: (str: string, lang: string): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch { /* fall through to plain */ }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`
  },
})

/** Render markdown source to sanitized HTML for the doc viewer. */
export function render_doc_markdown(src: string): string {
  const raw = md.render(src ?? ``)
  // Sanitize: strips <script>, on* handlers, javascript: URLs, etc., while
  // keeping the layout tags README files use. `align` (centered blocks/images)
  // and link `target`/`rel` aren't in every DOMPurify default allow-list, so
  // add them explicitly.
  return DOMPurify.sanitize(raw, { ADD_ATTR: [`align`, `target`, `rel`] })
}
