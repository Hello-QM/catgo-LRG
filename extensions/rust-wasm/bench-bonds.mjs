#!/usr/bin/env node
// Full-chain benchmark for the typed WASM bond-detection entry
// (`detect_bonds_radii_typed`): wasm call + BondTable typed-array getters.
// Mirrors extensions/rust/examples/bench_bonds.rs (27^3 = 19683 atoms,
// Si/O/Pt zeolite-ish composition, PBC TTT and FFF).
//
//   node scripts/build-wasm.mjs          # or: pnpm --dir extensions/rust-wasm build
//   node extensions/rust-wasm/bench-bonds.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as os from 'node:os'
import { Worker as NodeWorker } from 'node:worker_threads'

const N_SIDE = 27
const SPACING = 2.4
const A = N_SIDE * SPACING
const N = N_SIDE * N_SIDE * N_SIDE
const WARMUPS = 2
const SAMPLES = 7
const MAX_THREADS = 8
const PERFORMANCE_RATIO_LIMIT = 0.75
const THREAD_INIT_TIMEOUT_MS = 30_000
const logicalCores = os.availableParallelism?.() ?? os.cpus().length

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
        const jit = (v) =>
          ((v + 0.5 + (0.13 * ((k * (v + 7)) % 7)) / 7) / N_SIDE) * A
        positions[k * 3] = jit(i)
        positions[k * 3 + 1] = jit(j)
        positions[k * 3 + 2] = jit(l)
        k += 1
      }
    }
  }
  return { positions, atomicNumbers }
}

async function initializeArtifact(directory) {
  const pkg = await import(`./${directory}/ferrox.js`)
  const bytes = await readFile(
    new URL(`./${directory}/ferrox_bg.wasm`, import.meta.url),
  )
  try {
    await pkg.default({ module_or_path: bytes })
  } catch (objectError) {
    try {
      await pkg.default(bytes)
    } catch (bytesError) {
      throw new AggregateError(
        [objectError, bytesError],
        `${directory} initialization failed for both supported init signatures`,
      )
    }
  }
  return pkg
}

function readTypedOutput(table) {
  return Object.freeze({
    count: table.count,
    pairs: table.pairs,
    jimages: table.images,
    lengths: table.lengths,
    strengths: table.strengths,
  })
}

function serializeTypedOutput(output) {
  const copyBytes = (view) =>
    new Uint8Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    )
  return Object.freeze({
    count: output.count,
    pairs: copyBytes(output.pairs),
    jimages: copyBytes(output.jimages),
    lengths: copyBytes(output.lengths),
    strengths: copyBytes(output.strengths),
  })
}

function detectAndRead(pkg, positions, atomicNumbers, lattice, pbc) {
  const table = pkg.detect_bonds_radii_typed(
    positions,
    atomicNumbers,
    lattice,
    pbc,
  )
  try {
    return readTypedOutput(table)
  } finally {
    table.free()
  }
}

function benchmark(pkg, positions, atomicNumbers, lattice, pbc) {
  let output
  const run = () => {
    output = detectAndRead(pkg, positions, atomicNumbers, lattice, pbc)
  }

  for (let i = 0; i < WARMUPS; i++) run()

  const times = []
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now()
    run()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return {
    min: times[0],
    median: times[times.length >> 1],
    output,
  }
}

function assertByteParity(label, scalar, threaded) {
  const scalarBytes = serializeTypedOutput(scalar)
  const threadedBytes = serializeTypedOutput(threaded)
  assert.equal(threadedBytes.count, scalarBytes.count, `${label}: bond count differs`)
  for (const field of ['pairs', 'jimages', 'lengths', 'strengths']) {
    assert.deepEqual(
      threadedBytes[field],
      scalarBytes[field],
      `${label}: ${field} bytes differ`,
    )
  }
}

function printTiming(label, backend, result) {
  console.log(
    `${label} [${backend}]: ${N} atoms -> ${result.output.count} bonds | ` +
      `full chain min ${result.min.toFixed(1)}ms / median ` +
      `${result.median.toFixed(1)}ms (${WARMUPS} warmups + ${SAMPLES} samples)`,
  )
}

function errorText(error) {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(errorText).join(' | ')
    return `${error.name}: ${error.message}; causes: ${causes}`
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function installNodeWorkerShim() {
  const activeWorkers = new Set()
  let rejectWorkerFailure
  const workerFailure = new Promise((_, reject) => {
    rejectWorkerFailure = reject
  })
  const previous = new Map()

  for (const key of ['self', 'addEventListener', 'removeEventListener', 'Worker']) {
    previous.set(key, {
      present: Object.hasOwn(globalThis, key),
      value: globalThis[key],
    })
  }

  globalThis.self = globalThis
  globalThis.addEventListener ??= () => {}
  globalThis.removeEventListener ??= () => {}

  const bootstrap = `
    const { parentPort, workerData } = require('node:worker_threads')
    globalThis.self = globalThis
    globalThis.addEventListener = () => {}
    globalThis.removeEventListener = () => {}
    parentPort.once('message', async ({ init, receiver }) => {
      const pkg = await import(workerData.moduleUrl)
      await pkg.default(init)
      parentPort.postMessage({ type: 'wasm_bindgen_worker_ready' })
      pkg.wbg_rayon_start_worker(receiver)
    })
  `

  class WebWorkerShim {
    constructor(url) {
      const moduleUrl = new URL('../../../ferrox.js', url).href
      this.worker = new NodeWorker(bootstrap, {
        eval: true,
        workerData: { moduleUrl },
      })
      this.listeners = new Map()
      activeWorkers.add(this)
      this.worker.once('error', (error) => rejectWorkerFailure(error))
      this.worker.once('exit', () => activeWorkers.delete(this))
    }

    addEventListener(type, listener) {
      if (type !== 'message') return
      const wrapped = (data) => listener({ data })
      this.listeners.set(listener, wrapped)
      this.worker.on('message', wrapped)
    }

    removeEventListener(type, listener) {
      if (type !== 'message') return
      const wrapped = this.listeners.get(listener)
      if (wrapped) this.worker.off('message', wrapped)
      this.listeners.delete(listener)
    }

    postMessage(value, transferList) {
      if (transferList === undefined) this.worker.postMessage(value)
      else this.worker.postMessage(value, transferList)
    }

    async terminate() {
      activeWorkers.delete(this)
      await this.worker.terminate()
    }
  }

  globalThis.Worker = WebWorkerShim

  return {
    workerFailure,
    async cleanup() {
      await Promise.allSettled(
        [...activeWorkers].map((worker) => worker.terminate()),
      )
      for (const [key, state] of previous) {
        if (state.present) globalThis[key] = state.value
        else delete globalThis[key]
      }
    },
  }
}

async function initializeThreadedArtifact() {
  const shim = installNodeWorkerShim()
  try {
    const pkg = await initializeArtifact('pkg-threaded')
    if (typeof pkg.initThreadPool !== 'function') {
      throw new Error('pkg-threaded does not export initThreadPool')
    }
    const threadCount = Math.min(MAX_THREADS, Math.max(1, logicalCores - 1))
    let timeoutId
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(`initThreadPool timed out after ${THREAD_INIT_TIMEOUT_MS}ms`),
        )
      }, THREAD_INIT_TIMEOUT_MS)
    })
    try {
      await Promise.race([
        pkg.initThreadPool(threadCount),
        shim.workerFailure,
        timeout,
      ])
    } finally {
      clearTimeout(timeoutId)
    }
    return { pkg, threadCount, cleanup: shim.cleanup }
  } catch (error) {
    await shim.cleanup()
    throw error
  }
}

const { positions, atomicNumbers } = buildSynthetic()
const lattice = new Float64Array([A, 0, 0, 0, A, 0, 0, 0, A])
const fixtures = [
  ['pbc TTT', new Uint8Array([1, 1, 1])],
  ['pbc FFF', new Uint8Array([0, 0, 0])],
]

const scalarPkg = await initializeArtifact('pkg-scalar')
const scalarResults = new Map()
for (const [label, pbc] of fixtures) {
  const result = benchmark(scalarPkg, positions, atomicNumbers, lattice, pbc)
  scalarResults.set(label, result)
  printTiming(label, 'scalar', result)
}

let threaded
try {
  threaded = await initializeThreadedArtifact()
} catch (error) {
  const reason = errorText(error)
  console.warn(`threaded benchmark SKIP: ${reason}`)
  console.warn(`byte parity SKIP: threaded runtime unavailable (${reason})`)
  console.warn(`performance gate SKIP: threaded runtime unavailable (${reason})`)
  console.warn('STATUS: DONE_WITH_CONCERNS')
}

if (threaded) {
  let performanceGatesRun = 0
  try {
    console.log(
      `threaded runtime: ${threaded.threadCount} workers on ` +
        `${logicalCores} logical cores (shared-memory isolation confirmed)`,
    )
    for (const [label, pbc] of fixtures) {
      const scalar = scalarResults.get(label)
      const result = benchmark(
        threaded.pkg,
        positions,
        atomicNumbers,
        lattice,
        pbc,
      )
      printTiming(label, 'threaded', result)
      assertByteParity(label, scalar.output, result.output)
      console.log(`${label} byte parity PASS: pairs/jimages/lengths/strengths`)

      if (logicalCores < 4) {
        console.warn(
          `${label} performance gate SKIP: host has ${logicalCores} logical cores; ` +
            'at least 4 required',
        )
        continue
      }

      const ratio = result.median / scalar.median
      assert.ok(
        ratio <= PERFORMANCE_RATIO_LIMIT,
        `${label}: threaded median ${result.median.toFixed(1)}ms exceeds ` +
          `${PERFORMANCE_RATIO_LIMIT.toFixed(2)} * scalar median ` +
          `${scalar.median.toFixed(1)}ms (ratio ${ratio.toFixed(3)})`,
      )
      performanceGatesRun += 1
      console.log(
        `${label} performance gate PASS: threaded/scalar median ratio ` +
          `${ratio.toFixed(3)} <= ${PERFORMANCE_RATIO_LIMIT.toFixed(2)}`,
      )
    }
    console.log(
      performanceGatesRun === fixtures.length
        ? 'STATUS: DONE'
        : 'STATUS: DONE_WITH_SKIPS',
    )
  } finally {
    await threaded.cleanup()
  }
}
