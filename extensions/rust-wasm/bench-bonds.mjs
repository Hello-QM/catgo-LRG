// Full-chain benchmark for the typed WASM bond-detection entry
// (`detect_bonds_radii_typed`): wasm call + BondTable typed-array getters.
// Mirrors extensions/rust/examples/bench_bonds.rs (27^3 = 19683 atoms,
// Si/O/Pt zeolite-ish composition, PBC TTT and FFF).
//
//   node scripts/build-wasm.mjs          # or: pnpm --dir extensions/rust-wasm build
//   node extensions/rust-wasm/bench-bonds.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as os from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
const OUTPUT_FIELDS = ['pairs', 'jimages', 'lengths', 'strengths']

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

function errorText(error) {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(errorText).join(' | ')
    return `${error.name}: ${error.message}; causes: ${causes}`
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
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

function isMissingScalarArtifact(error) {
  if (!(error instanceof Error)) return false
  const code = error.code
  const missing = code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT'
  return missing && error.message.includes('pkg-scalar')
}

export async function initializeScalarArtifact(loadArtifact = initializeArtifact) {
  try {
    return {
      directory: 'pkg-scalar',
      pkg: await loadArtifact('pkg-scalar'),
    }
  } catch (error) {
    if (!isMissingScalarArtifact(error)) throw error
    return { directory: 'pkg', pkg: await loadArtifact('pkg') }
  }
}

function supportsWasmSharedMemory() {
  if (typeof globalThis.SharedArrayBuffer !== 'function') return false
  try {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    })
    return memory.buffer instanceof globalThis.SharedArrayBuffer
  } catch {
    return false
  }
}

function detectHostCapabilities() {
  return {
    logicalCores: os.availableParallelism?.() ?? os.cpus().length,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
    wasmSharedMemory: supportsWasmSharedMemory(),
    workerThreads: typeof NodeWorker === 'function',
  }
}

export function assessHostEligibility(capabilities) {
  if (capabilities.logicalCores < 4) {
    return {
      eligible: false,
      reason:
        `host has ${capabilities.logicalCores} logical cores; ` +
        'at least 4 required',
    }
  }
  if (!capabilities.sharedArrayBuffer) {
    return { eligible: false, reason: 'SharedArrayBuffer unavailable' }
  }
  if (!capabilities.wasmSharedMemory) {
    return { eligible: false, reason: 'WebAssembly shared memory unavailable' }
  }
  if (!capabilities.workerThreads) {
    return { eligible: false, reason: 'Node worker_threads unavailable' }
  }
  return {
    eligible: true,
    reason: `eligible shared-memory host with ${capabilities.logicalCores} cores`,
  }
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

function hashTypedOutput(output) {
  const hash = createHash('sha256')
  hash.update(`count:${output.count};`)
  for (const field of OUTPUT_FIELDS) {
    hash.update(`${field}:${output[field].byteLength};`)
    hash.update(output[field])
  }
  return hash.digest('hex')
}

function assertByteParity(label, expected, actual) {
  assert.equal(actual.count, expected.count, `${label}: bond count differs`)
  for (const field of OUTPUT_FIELDS) {
    assert.deepEqual(
      actual[field],
      expected[field],
      `${label}: ${field} bytes differ`,
    )
  }
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

export async function measureDeterministicSamples({
  label,
  backend,
  run,
  expectedBytes = null,
  checkHealth = async () => {},
  warmups = WARMUPS,
  samples = SAMPLES,
}) {
  let canonicalBytes = expectedBytes
  let output

  const validate = async (phase, index) => {
    const bytes = serializeTypedOutput(output)
    const context = `${label} ${backend} ${phase} ${index}`
    if (canonicalBytes === null) canonicalBytes = bytes
    else assertByteParity(context, canonicalBytes, bytes)
    const hash = hashTypedOutput(bytes)
    await checkHealth()
    return hash
  }

  for (let i = 0; i < warmups; i++) {
    output = run()
    await validate('warmup', i + 1)
  }

  const times = []
  const sampleHashes = []
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    output = run()
    times.push(performance.now() - t0)
    sampleHashes.push(await validate('timed sample', i + 1))
  }
  times.sort((a, b) => a - b)

  return {
    min: times[0],
    median: times[times.length >> 1],
    output,
    canonicalBytes,
    sampleHashes,
  }
}

function printTiming(label, backend, result) {
  console.log(
    `${label} [${backend}]: ${N} atoms -> ${result.output.count} bonds | ` +
      `full chain min ${result.min.toFixed(1)}ms / median ` +
      `${result.median.toFixed(1)}ms (${WARMUPS} warmups + ${SAMPLES} samples)`,
  )
}

function installNodeWorkerShim() {
  const activeWorkers = new Set()
  const healthErrors = []
  let rejectHealthFailure
  let cleaned = false
  const healthFailure = new Promise((_, reject) => {
    rejectHealthFailure = reject
  })
  const previous = new Map()

  const recordHealthFailure = (error) => {
    healthErrors.push(error)
    if (healthErrors.length === 1) rejectHealthFailure(error)
  }

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
      this.expectedTermination = false
      this.worker = new NodeWorker(bootstrap, {
        eval: true,
        workerData: { moduleUrl },
      })
      this.listeners = new Map()
      activeWorkers.add(this)
      this.worker.once('error', (cause) => {
        if (!this.expectedTermination) {
          recordHealthFailure(
            new Error(`Rayon worker error: ${errorText(cause)}`, { cause }),
          )
        }
      })
      this.worker.once('exit', (code) => {
        activeWorkers.delete(this)
        if (!this.expectedTermination) {
          recordHealthFailure(
            new Error(`Rayon worker exited unexpectedly with code ${code}`),
          )
        }
      })
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

    terminate() {
      this.expectedTermination = true
      return this.worker.terminate()
    }
  }

  globalThis.Worker = WebWorkerShim

  const restoreGlobals = () => {
    for (const [key, state] of previous) {
      if (state.present) globalThis[key] = state.value
      else delete globalThis[key]
    }
  }

  const assertHealthy = () => {
    if (healthErrors.length > 0) {
      throw new AggregateError(
        [...healthErrors],
        'Rayon worker health failure during benchmark',
      )
    }
  }

  return {
    healthFailure,
    async checkHealth() {
      await new Promise((resolve) => setImmediate(resolve))
      assertHealthy()
    },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      // Flush pending error/exit events before marking any exit as intentional.
      await new Promise((resolve) => setImmediate(resolve))
      const workers = [...activeWorkers]
      const settlements = await Promise.allSettled(
        workers.map((worker) => worker.terminate()),
      )
      await new Promise((resolve) => setImmediate(resolve))
      restoreGlobals()

      const terminationErrors = settlements
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
      const failures = [...healthErrors, ...terminationErrors]
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'Rayon worker cleanup or health check failed',
        )
      }
    },
  }
}

async function initializeThreadedArtifact(logicalCores) {
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
        shim.healthFailure,
        timeout,
      ])
    } finally {
      clearTimeout(timeoutId)
    }
    await shim.checkHealth()
    return {
      pkg,
      threadCount,
      checkHealth: shim.checkHealth,
      cleanup: shim.cleanup,
    }
  } catch (error) {
    try {
      await shim.cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'threaded initialization and cleanup both failed',
      )
    }
    throw error
  }
}

export async function runBenchmarkGate({
  eligibility,
  runScalar,
  initializeThreaded,
  runThreaded,
  log = console.log,
}) {
  if (!eligibility.eligible) {
    log(`STATUS: SKIP: ${eligibility.reason}`)
    return { status: 'skip', reason: eligibility.reason }
  }

  const scalar = await runScalar()
  const threaded = await initializeThreaded()
  let runError
  try {
    await runThreaded(threaded, scalar)
  } catch (error) {
    runError = error
  }

  let cleanupError
  try {
    await threaded.cleanup()
  } catch (error) {
    cleanupError = error
  }

  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      'threaded benchmark and worker cleanup both failed',
    )
  }
  if (runError) throw runError
  if (cleanupError) throw cleanupError

  log('STATUS: DONE')
  return { status: 'done', scalar }
}

export async function runBenchmarkCli(
  run,
  { error = console.error, processState = process } = {},
) {
  try {
    return await run()
  } catch (cause) {
    processState.exitCode = 1
    error(`STATUS: FAILED: ${errorText(cause)}`)
    return { status: 'failed', error: cause }
  }
}

function fixtures() {
  return [
    ['pbc TTT', new Uint8Array([1, 1, 1])],
    ['pbc FFF', new Uint8Array([0, 0, 0])],
  ]
}

async function main() {
  const capabilities = detectHostCapabilities()
  const eligibility = assessHostEligibility(capabilities)
  const { positions, atomicNumbers } = buildSynthetic()
  const lattice = new Float64Array([A, 0, 0, 0, A, 0, 0, 0, A])
  const benchmarkFixtures = fixtures()

  await runBenchmarkGate({
    eligibility,
    runScalar: async () => {
      const scalarArtifact = await initializeScalarArtifact()
      if (scalarArtifact.directory === 'pkg') {
        console.log('scalar artifact: pkg (legacy fallback; pkg-scalar missing)')
      } else {
        console.log('scalar artifact: pkg-scalar')
      }

      const results = new Map()
      for (const [label, pbc] of benchmarkFixtures) {
        const result = await measureDeterministicSamples({
          label,
          backend: 'scalar',
          run: () =>
            detectAndRead(
              scalarArtifact.pkg,
              positions,
              atomicNumbers,
              lattice,
              pbc,
            ),
        })
        results.set(label, result)
        printTiming(label, 'scalar', result)
        console.log(
          `${label} scalar determinism verified: ` +
            `${result.sampleHashes.length}/${SAMPLES} timed samples`,
        )
      }
      return results
    },
    initializeThreaded: () =>
      initializeThreadedArtifact(capabilities.logicalCores),
    runThreaded: async (threaded, scalarResults) => {
      console.log(
        `threaded runtime: ${threaded.threadCount} workers on ` +
          `${capabilities.logicalCores} logical cores`,
      )
      for (const [label, pbc] of benchmarkFixtures) {
        const scalar = scalarResults.get(label)
        const result = await measureDeterministicSamples({
          label,
          backend: 'threaded',
          expectedBytes: scalar.canonicalBytes,
          checkHealth: threaded.checkHealth,
          run: () =>
            detectAndRead(
              threaded.pkg,
              positions,
              atomicNumbers,
              lattice,
              pbc,
            ),
        })
        printTiming(label, 'threaded', result)
        console.log(
          `${label} byte parity PASS: pairs/jimages/lengths/strengths ` +
            `for ${result.sampleHashes.length}/${SAMPLES} timed samples`,
        )

        const ratio = result.median / scalar.median
        assert.ok(
          ratio <= PERFORMANCE_RATIO_LIMIT,
          `${label}: threaded median ${result.median.toFixed(1)}ms exceeds ` +
            `${PERFORMANCE_RATIO_LIMIT.toFixed(2)} * scalar median ` +
            `${scalar.median.toFixed(1)}ms (ratio ${ratio.toFixed(3)})`,
        )
        console.log(
          `${label} performance gate PASS: threaded/scalar median ratio ` +
            `${ratio.toFixed(3)} <= ${PERFORMANCE_RATIO_LIMIT.toFixed(2)}`,
        )
      }
    },
  })
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await runBenchmarkCli(main)
