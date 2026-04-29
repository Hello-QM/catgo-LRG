import type { DocChunk } from './types'

let chunks: DocChunk[] = []
let idf_cache: Map<string, number> | null = null
let avg_chunk_length = 200

/** Tokenize text into lowercase words */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
}

/** Compute term frequency map */
function term_freq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1)
  }
  return tf
}

/** Materials science synonyms for query expansion */
const SYNONYMS: Record<string, string[]> = {
  relax: [`optimize`, `optimization`, `relaxation`, `geometry`],
  optimize: [`relax`, `relaxation`, `optimization`],
  cell: [`lattice`, `unit`, `periodic`, `pbc`],
  lattice: [`cell`, `unit`, `periodic`, `pbc`],
  slab: [`surface`, `miller`, `termination`],
  surface: [`slab`, `miller`, `termination`],
  dos: [`density`, `states`, `electronic`],
  bands: [`band`, `structure`, `electronic`, `dispersion`],
  md: [`molecular`, `dynamics`, `trajectory`],
  vasp: [`incar`, `poscar`, `kpoints`, `dft`],
  dft: [`vasp`, `qe`, `calculation`, `functional`],
  bond: [`bonds`, `bonding`, `connectivity`],
  atom: [`atoms`, `site`, `sites`, `species`],
  defect: [`vacancy`, `interstitial`, `substitutional`],
  adsorb: [`adsorption`, `adsorbate`, `binding`],
}

/** Expand query tokens with synonyms (limited to avoid noise) */
function expand_query(tokens: string[]): string[] {
  const expanded = new Set(tokens)
  for (const t of tokens) {
    const syns = SYNONYMS[t]
    if (syns) {
      for (const s of syns) expanded.add(s)
    }
  }
  return Array.from(expanded)
}

/** Lazily compute IDF over all doc chunks */
function get_idf(): Map<string, number> {
  if (idf_cache) return idf_cache

  const doc_freq = new Map<string, number>()
  const n = chunks.length
  let total_len = 0

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.content)
    total_len += tokens.length
    const unique_tokens = new Set(tokens)
    for (const t of unique_tokens) {
      doc_freq.set(t, (doc_freq.get(t) ?? 0) + 1)
    }
  }

  avg_chunk_length = n > 0 ? total_len / n : 200

  idf_cache = new Map<string, number>()
  for (const [term, df] of doc_freq) {
    idf_cache.set(term, Math.log((n + 1) / (df + 1)) + 1)
  }
  return idf_cache
}

/** BM25-style scoring of a query against a chunk */
function score_chunk(query_tokens: string[], chunk: DocChunk): number {
  const idf = get_idf()
  const chunk_tokens = tokenize(chunk.content)
  const tf = term_freq(chunk_tokens)
  const doc_len = chunk_tokens.length
  const k1 = 1.5
  const b = 0.75

  let score = 0
  for (const qt of query_tokens) {
    const f = tf.get(qt) ?? 0
    if (f === 0) continue
    const idf_val = idf.get(qt) ?? 1
    score += idf_val * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc_len / avg_chunk_length))))
  }

  // Boost heading matches (use tokenized word matching, not substring)
  if (score > 0) {
    const heading_tokens = new Set(tokenize(chunk.heading))
    for (const qt of query_tokens) {
      if (heading_tokens.has(qt)) score *= 1.3
    }
  }

  return score
}

/** Load chunks from the bundled JSON */
export async function load_chunks(): Promise<void> {
  if (chunks.length > 0) return
  const mod = await import(`./docs-chunks.json`)
  chunks = mod.default as DocChunk[]
  idf_cache = null // reset IDF cache
}

/** Retrieve top-k relevant chunks for a query */
export async function retrieve(query: string, top_k = 5): Promise<DocChunk[]> {
  await load_chunks()
  if (chunks.length === 0) return []

  const raw_tokens = tokenize(query)
  if (raw_tokens.length === 0) return []

  // Expand query with domain synonyms for better recall
  const query_tokens = expand_query(raw_tokens)

  const scored = chunks.map((chunk) => ({
    chunk,
    score: score_chunk(query_tokens, chunk),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, top_k).filter((s) => s.score > 0).map((s) => s.chunk)
}
