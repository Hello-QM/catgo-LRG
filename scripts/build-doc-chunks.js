#!/usr/bin/env node

/**
 * Build script that reads all docs/**\/*.md files, splits on ## headings
 * into ~500 token chunks, and outputs src/lib/chat/docs-chunks.json.
 *
 * Run: node scripts/build-doc-chunks.js
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const DOCS_DIR = join(import.meta.dirname, `..`, `docs`)
const OUTPUT_PATH = join(import.meta.dirname, `..`, `src`, `lib`, `chat`, `docs-chunks.json`)
const MAX_TOKENS = 500 // approximate token limit per chunk

function walk_md_files(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...walk_md_files(full))
    } else if (entry.endsWith(`.md`)) {
      results.push(full)
    }
  }
  return results
}

/** Rough token count — split on whitespace */
function token_count(text) {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Split markdown content into chunks on ## headings.
 * If a chunk exceeds MAX_TOKENS, split further on paragraphs.
 */
function chunk_markdown(content, source) {
  const chunks = []
  // Split on ## headings (keep the heading with its content)
  const sections = content.split(/^(?=## )/m)

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed) continue

    // Extract heading if present
    const heading_match = trimmed.match(/^##+ (.+)/)
    const heading = heading_match ? heading_match[1].trim() : ``

    if (token_count(trimmed) <= MAX_TOKENS) {
      chunks.push({ source, heading, content: trimmed })
    } else {
      // Split large sections on double newlines (paragraphs)
      const paragraphs = trimmed.split(/\n\n+/)
      let current = ``
      let current_heading = heading

      for (const para of paragraphs) {
        if (current && token_count(current + `\n\n` + para) > MAX_TOKENS) {
          chunks.push({ source, heading: current_heading, content: current.trim() })
          current = para
          // Keep heading context for continuation chunks
          current_heading = heading ? `${heading} (cont.)` : ``
        } else {
          current = current ? current + `\n\n` + para : para
        }
      }
      if (current.trim()) {
        chunks.push({ source, heading: current_heading, content: current.trim() })
      }
    }
  }

  return chunks
}

// Main
const md_files = walk_md_files(DOCS_DIR)
const all_chunks = []

for (const file of md_files) {
  const content = readFileSync(file, `utf-8`)
  const rel_path = relative(DOCS_DIR, file)
  const chunks = chunk_markdown(content, rel_path)
  all_chunks.push(...chunks)
}

// Add an id to each chunk
const output = all_chunks.map((chunk, idx) => ({
  id: idx,
  ...chunk,
}))

writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2))
console.log(`Built ${output.length} doc chunks from ${md_files.length} files → ${OUTPUT_PATH}`)
