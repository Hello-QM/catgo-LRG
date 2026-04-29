/**
 * Multi-strategy command matching pipeline with accent robustness.
 *
 * Priority: exact substring → normalized exact → fuzzy (Fuse.js) →
 *           word-level fuzzy → phonetic (Double Metaphone primary+secondary) → AI routing.
 *
 * Accent handling:
 * - Text normalization strips filler words, hesitations, politeness markers
 * - Double Metaphone uses BOTH primary and secondary codes (secondary captures accent variants)
 * - Word-level matching: "wotate left" matches "rotate left" even though full-string fails
 * - Fuse.js threshold is tuned for accent-induced edit distances
 */

import Fuse from 'fuse.js'
import { doubleMetaphone } from 'double-metaphone'
import type { VoiceAction } from './gesture-types'
import type { CommandEntry } from './voice-engine'

export interface FuzzyMatchResult {
  action: VoiceAction
  match_score: number
}

// ─── Lazy Index ──────────────────────────────────────────────────────

interface IndexEntry {
  pattern: string
  action: VoiceAction
  /** Pre-computed Double Metaphone codes [primary, secondary] (null for CJK) */
  metaphone_codes: [string, string] | null
  /** Individual words for word-level matching */
  words: string[]
}

let fuse_index: Fuse<IndexEntry> | null = null
let cached_entries: IndexEntry[] = []

function is_cjk(text: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text)
}

function build_index(commands: CommandEntry[], element_map: Record<string, string>): void {
  cached_entries = []

  for (const cmd of commands) {
    for (const pattern of cmd.patterns) {
      cached_entries.push({
        pattern,
        action: cmd.action,
        metaphone_codes: is_cjk(pattern) ? null : doubleMetaphone(pattern) as [string, string],
        words: pattern.split(/\s+/),
      })
    }
  }

  for (const [name, symbol] of Object.entries(element_map)) {
    cached_entries.push({
      pattern: name,
      action: { type: `element`, symbol },
      metaphone_codes: is_cjk(name) ? null : doubleMetaphone(name) as [string, string],
      words: [name],
    })
  }

  fuse_index = new Fuse(cached_entries, {
    keys: [`pattern`],
    threshold: 0.5,    // Slightly higher than default to catch accent variants
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
  })
}

/** Clear the cached Fuse.js index (e.g. when commands change). */
export function reset_fuzzy_index(): void {
  fuse_index = null
  cached_entries = []
}

// ─── Text Normalization ──────────────────────────────────────────────

/** Filler words, hesitations, and politeness markers that STT often transcribes from accented speech. */
const FILLER_PATTERN = /\b(um+|uh+|er+|ah+|oh+|hmm+|like|okay|ok|so|well|please|can you|could you|i want to|i'd like to)\b/gi

/** Normalize input text: strip fillers, collapse whitespace, trim. */
function normalize(text: string): string {
  return text
    .replace(FILLER_PATTERN, ` `)
    .replace(/['']/g, `'`)       // Smart quotes → ASCII
    .replace(/\s+/g, ` `)
    .trim()
}

// ─── Word-Level Matching ─────────────────────────────────────────────

/**
 * For multi-word commands, check if each command word has a close match
 * in the input words. This catches "wotate left" → "rotate left" where
 * full-string fuzzy matching might fail.
 *
 * Returns a score 0-1 representing the fraction of command words matched.
 */
function word_level_score(input_words: string[], entry: IndexEntry): number {
  if (entry.words.length === 0) return 0
  if (entry.words.length === 1) return 0 // Single-word handled by Fuse.js already

  let matched = 0
  for (const cmd_word of entry.words) {
    if (is_cjk(cmd_word)) {
      // CJK: exact substring
      if (input_words.some(w => w.includes(cmd_word))) matched++
      continue
    }

    const cmd_codes = doubleMetaphone(cmd_word) as [string, string]

    for (const input_word of input_words) {
      // Exact match
      if (input_word === cmd_word) { matched++; break }

      // Edit distance: allow 1 error per 4 chars (accent tolerance)
      const max_dist = Math.max(1, Math.floor(cmd_word.length / 4))
      if (levenshtein(input_word, cmd_word) <= max_dist) { matched++; break }

      // Phonetic match (either primary or secondary code)
      if (!is_cjk(input_word)) {
        const input_codes = doubleMetaphone(input_word) as [string, string]
        if (codes_match(input_codes, cmd_codes)) { matched++; break }
      }
    }
  }

  return matched / entry.words.length
}

/** Check if any of the two DM code pairs match (primary↔primary, primary↔secondary, etc.) */
function codes_match(a: [string, string], b: [string, string]): boolean {
  return (a[0] !== `` && (a[0] === b[0] || a[0] === b[1]))
    || (a[1] !== `` && (a[1] === b[0] || a[1] === b[1]))
}

/** Simple Levenshtein distance — fine for short command words (<20 chars). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Single-row DP
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)

  for (let i = 1; i <= a.length; i++) {
    let prev = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const val = Math.min(
        row[j] + 1,      // deletion
        prev + 1,         // insertion
        row[j - 1] + cost, // substitution
      )
      row[j - 1] = prev
      prev = val
    }
    row[b.length] = prev
  }

  return row[b.length]
}

// ─── Phonetic Matching (Both DM Codes) ──────────────────────────────

/**
 * Score a phonetic match between input and an entry.
 * Uses both primary and secondary Double Metaphone codes to capture accent variants.
 * Secondary codes specifically model alternate pronunciations.
 */
function phonetic_score(input: string, entry: IndexEntry): number {
  if (!entry.metaphone_codes) return 0
  if (is_cjk(input)) return 0

  const input_codes = doubleMetaphone(input) as [string, string]
  const entry_codes = entry.metaphone_codes

  // Exact match on any code combination
  if (codes_match(input_codes, entry_codes)) return 0.8

  // Prefix match (at least 3 chars) on any code combination
  const min_prefix = 3
  for (const ic of input_codes) {
    if (ic.length < min_prefix) continue
    for (const ec of entry_codes) {
      if (ec.length < min_prefix) continue
      if (ic.startsWith(ec.slice(0, min_prefix)) || ec.startsWith(ic.slice(0, min_prefix))) {
        return 0.6
      }
    }
  }

  return 0
}

// ─── Matching Pipeline ───────────────────────────────────────────────

const ACCEPT_THRESHOLD = 0.55
const FUZZY_WEIGHT = 0.7
const CONFIDENCE_WEIGHT = 0.3

export function fuzzy_match_command(
  text: string,
  commands: CommandEntry[],
  element_map: Record<string, string>,
  stt_confidence: number,
  ai_enabled: boolean,
): FuzzyMatchResult {
  const raw_lower = text.toLowerCase().trim()
  if (!raw_lower) return { action: { type: `unknown`, raw: text }, match_score: 0 }

  // Normalize: strip filler words, hesitations
  const lower = normalize(raw_lower)
  if (!lower) return { action: { type: `unknown`, raw: text }, match_score: 0 }

  // ── Step 1: Exact substring match (on both raw and normalized) ──

  for (const candidate of [lower, raw_lower]) {
    for (const [name, symbol] of Object.entries(element_map)) {
      if (candidate === name || candidate.includes(name)) {
        return { action: { type: `element`, symbol }, match_score: 1.0 }
      }
    }

    for (const cmd of commands) {
      for (const pattern of cmd.patterns) {
        if (candidate.includes(pattern)) {
          return { action: cmd.action, match_score: 1.0 }
        }
      }
    }
  }

  // Ensure index is built
  if (!fuse_index) build_index(commands, element_map)

  // ── Step 2: Fuzzy match via Fuse.js ──

  const results = fuse_index!.search(lower, { limit: 5 })

  if (results.length > 0) {
    const best = results[0]
    const fuzzy_score = 1 - (best.score ?? 0.5)
    const combined = fuzzy_score * FUZZY_WEIGHT + stt_confidence * CONFIDENCE_WEIGHT

    if (combined >= ACCEPT_THRESHOLD) {
      return { action: best.item.action, match_score: combined }
    }
  }

  // ── Step 3: Word-level fuzzy match (catches "wotate left" → "rotate left") ──

  const input_words = lower.split(/\s+/)

  if (input_words.length >= 2) {
    let best_word_entry: IndexEntry | null = null
    let best_word_score = 0

    for (const entry of cached_entries) {
      if (entry.words.length < 2) continue
      const score = word_level_score(input_words, entry)
      if (score > best_word_score) {
        best_word_score = score
        best_word_entry = entry
      }
    }

    if (best_word_entry && best_word_score >= 0.8) {
      const combined = best_word_score * FUZZY_WEIGHT + stt_confidence * CONFIDENCE_WEIGHT
      if (combined >= ACCEPT_THRESHOLD) {
        return { action: best_word_entry.action, match_score: combined }
      }
    }
  }

  // ── Step 4: Phonetic fallback (both primary + secondary DM codes) ──

  {
    let best_phonetic: IndexEntry | null = null
    let best_phonetic_score = 0

    for (const entry of cached_entries) {
      const score = phonetic_score(lower, entry)
      if (score > best_phonetic_score) {
        best_phonetic = entry
        best_phonetic_score = score
      }
    }

    if (best_phonetic) {
      const combined = best_phonetic_score * FUZZY_WEIGHT + stt_confidence * CONFIDENCE_WEIGHT
      if (combined >= ACCEPT_THRESHOLD) {
        return { action: best_phonetic.action, match_score: combined }
      }
    }
  }

  // ── Step 5: AI routing fallback ──

  const draw_patterns = [`draw`, `paint`, `sketch`, `画`, `画一`]
  for (const p of draw_patterns) {
    if (lower.includes(p) && ai_enabled) {
      return { action: { type: `ai_query`, raw: `[ATOM ART] ${text}` }, match_score: 0.5 }
    }
  }

  if (ai_enabled && lower.length > 3) {
    return { action: { type: `ai_query`, raw: text }, match_score: 0.3 }
  }

  return { action: { type: `unknown`, raw: text }, match_score: 0 }
}
