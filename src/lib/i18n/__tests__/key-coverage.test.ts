import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * i18n key-coverage sweep: every `t('module.key')` call (and raw
 * `'workflow.*'` keys stored in node-definitions param defs) must resolve in
 * BOTH locale packs. A missing key makes t() fall back to the raw key, so the
 * UI shows "WORKFLOW.NODE_GROUP_SOFTWARE"-style text — this kept happening
 * one key at a time (si_confirm_import, editor_calc_type_label, node_group_*…).
 */

const MODULES = [`common`, `app`, `sidebar`, `structure`, `workflow`, `chat`, `mobile`]
const SRC = join(__dirname, `..`, `..`, `..`)  // → src/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === `__tests__` || entry.name === `node_modules`) continue
      walk(p, out)
    } else if (/\.(ts|svelte)$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

function collect_used_keys(): Map<string, string> {
  const used = new Map<string, string>()
  for (const file of walk(join(SRC, `lib`))) {
    if (file.includes(`${join(`lib`, `i18n`)}`)) continue
    const text = readFileSync(file, `utf-8`)
    // t('module.key') / t(`module.key`) / t("module.key")
    for (const m of text.matchAll(/\bt\(\s*[`'"](\w+)\.([A-Za-z0-9_.]+)[`'"]/g)) {
      used.set(`${m[1]}.${m[2]}`, file)
    }
    // raw keys stored in defs and translated at render time
    for (const m of text.matchAll(/[`'"](workflow\.[a-z0-9_.]+)[`'"]/g)) {
      used.set(m[1], file)
    }
  }
  return used
}

function load_pack_keys(locale: string, mod: string): Set<string> {
  const text = readFileSync(join(SRC, `lib`, `i18n`, locale, `${mod}.ts`), `utf-8`)
  return new Set(
    [...text.matchAll(/^\s*'?([A-Za-z0-9_.]+)'?\s*:/gm)].map(m => m[1]),
  )
}

describe(`i18n key coverage`, () => {
  const used = collect_used_keys()

  for (const locale of [`en`, `zh`]) {
    it(`every referenced key exists in the ${locale} packs`, () => {
      const missing: string[] = []
      for (const mod of MODULES) {
        const pack = load_pack_keys(locale, mod)
        for (const [key, file] of used) {
          if (!key.startsWith(`${mod}.`)) continue
          const sub = key.slice(mod.length + 1)
          if (!pack.has(sub)) missing.push(`${key}  (used in ${file.split(`/src/`)[1] ?? file})`)
        }
      }
      expect(missing).toEqual([])
    })
  }
})
