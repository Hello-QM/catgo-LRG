#!/usr/bin/env node
// Full-chain benchmark for the typed WASM bond-detection entry
// (`detect_bonds_radii_typed`): wasm call + BondTable typed-array getters.
// Mirrors extensions/rust/examples/bench_bonds.rs (27^3 = 19683 atoms,
// Si/O/Pt zeolite-ish composition, PBC TTT and FFF).
//
//   node scripts/build-wasm.mjs          # or: pnpm --dir extensions/rust-wasm build
//   node extensions/rust-wasm/bench-bonds.mjs
import { readFile } from 'node:fs/promises'

const N_SIDE = 27
const SPACING = 2.4
const A = N_SIDE * SPACING
const N = N_SIDE * N_SIDE * N_SIDE

function buildSynthetic() {
  const positions = new Float32Array(N * 3)
  const atomicNumbers = new Uint8Array(N)
  let k = 0
  for (let i = 0; i < N_SIDE; i++) {
    for (let j = 0; j < N_SIDE; j++) {
      for (let l = 0; l < N_SIDE; l++) {
        // Si/O alternation + a few Pt — same recipe as bench_bonds.rs
        const m = k % 13
        atomicNumbers[k] = m <= 3 ? 14 : m === 12 ? 78 : 8
        const jit = (v) => ((v + 0.5 + (0.13 * ((k * (v + 7)) % 7)) / 7) / N_SIDE) * A
        positions[k * 3] = jit(i)
        positions[k * 3 + 1] = jit(j)
        positions[k * 3 + 2] = jit(l)
        k += 1
      }
    }
  }
  return { positions, atomicNumbers }
}

function timeIt(iters, f) {
  f() // warmup
  f()
  const times = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    f()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { min: times[0], median: times[times.length >> 1] }
}

const pkg = await import('./pkg/ferrox.js')
const bytes = await readFile(new URL('./pkg/ferrox_bg.wasm', import.meta.url))
try {
  await pkg.default({ module_or_path: bytes })
} catch {
  await pkg.default(bytes)
}

const { positions, atomicNumbers } = buildSynthetic()
const lattice = new Float64Array([A, 0, 0, 0, A, 0, 0, 0, A])

for (const [label, pbc] of [
  ['pbc TTT', new Uint8Array([1, 1, 1])],
  ['pbc FFF', new Uint8Array([0, 0, 0])],
]) {
  // Full chain: detect call + copying every typed array out of WASM memory.
  let nBonds = 0
  const fullChain = () => {
    const table = pkg.detect_bonds_radii_typed(positions, atomicNumbers, lattice, pbc)
    nBonds = table.count
    const out = [table.pairs, table.images, table.lengths, table.strengths]
    table.free()
    return out
  }
  const t = timeIt(7, fullChain)
  console.log(
    `${label}: ${N} atoms -> ${nBonds} bonds | full chain min ${t.min.toFixed(1)}ms / ` +
      `median ${t.median.toFixed(1)}ms (7 iters)`,
  )
}
