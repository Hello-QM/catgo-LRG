import { describe, expect, it } from 'vitest'
import { parse_render_backend_policy } from '$lib/structure/render-backend-policy'
import {
  assessHostEligibility,
  initializeScalarArtifact,
  measureDeterministicSamples,
  runBenchmarkCli,
  runBenchmarkGate,
} from '../../../extensions/rust-wasm/bench-bonds.mjs'

describe('parse_render_backend_policy', () => {
  it('defaults to auto when the query parameter is absent', () => {
    expect(parse_render_backend_policy('?other=value')).toEqual({
      policy: 'auto',
      diagnostics: {
        parameter: 'catgo_renderer',
        requested_value: null,
        forced: false,
        reason: 'default',
      },
    })
  })

  it('accepts the exact webgpu forced value', () => {
    expect(parse_render_backend_policy('?catgo_renderer=webgpu')).toEqual({
      policy: 'webgpu',
      diagnostics: {
        parameter: 'catgo_renderer',
        requested_value: 'webgpu',
        forced: true,
        reason: 'forced',
      },
    })
  })

  it('accepts the exact webgl2-wasm forced value', () => {
    expect(parse_render_backend_policy('?catgo_renderer=webgl2-wasm')).toEqual({
      policy: 'webgl2-wasm',
      diagnostics: {
        parameter: 'catgo_renderer',
        requested_value: 'webgl2-wasm',
        forced: true,
        reason: 'forced',
      },
    })
  })

  it('falls back to auto with an empty-value diagnostic', () => {
    expect(parse_render_backend_policy('?catgo_renderer=')).toEqual({
      policy: 'auto',
      diagnostics: {
        parameter: 'catgo_renderer',
        requested_value: '',
        forced: false,
        reason: 'empty-value',
      },
    })
  })

  it.each(['auto', 'WebGPU', 'webgpu ', 'webgl2', 'unknown'])(
    'rejects non-exact value %j with an unknown-value diagnostic',
    (requested_value) => {
      expect(
        parse_render_backend_policy(
          `?catgo_renderer=${encodeURIComponent(requested_value)}`,
        ),
      ).toEqual({
        policy: 'auto',
        diagnostics: {
          parameter: 'catgo_renderer',
          requested_value,
          forced: false,
          reason: 'unknown-value',
        },
      })
    },
  )

  it('returns a read-only selection and diagnostics object', () => {
    const selection = parse_render_backend_policy('?catgo_renderer=webgpu')

    expect(Object.isFrozen(selection)).toBe(true)
    expect(Object.isFrozen(selection.diagnostics)).toBe(true)
  })
})

describe('WASM benchmark gate', () => {
  const eligible = assessHostEligibility({
    logicalCores: 8,
    sharedArrayBuffer: true,
    wasmSharedMemory: true,
    workerThreads: true,
  })

  it('skips ineligible hosts before threaded initialization', async () => {
    const events: string[] = []
    let threadedInitCalls = 0
    const result = await runBenchmarkGate({
      eligibility: assessHostEligibility({
        logicalCores: 2,
        sharedArrayBuffer: true,
        wasmSharedMemory: true,
        workerThreads: true,
      }),
      runScalar: async () => events.push('scalar'),
      initializeThreaded: async () => {
        threadedInitCalls += 1
        throw new Error('must not initialize')
      },
      runThreaded: async () => events.push('threaded'),
      log: (message: string) => events.push(message),
    })

    expect(result.status).toBe('skip')
    expect(threadedInitCalls).toBe(0)
    expect(events).toEqual([
      'STATUS: SKIP: host has 2 logical cores; at least 4 required',
    ])
    expect(events.join('\n')).not.toMatch(/DONE|parity PASS|performance gate PASS/)
  })

  it('fails an eligible host when threaded initialization fails', async () => {
    const events: string[] = []
    await expect(
      runBenchmarkGate({
        eligibility: eligible,
        runScalar: async () => events.push('scalar'),
        initializeThreaded: async () => {
          throw new Error('threaded artifact missing')
        },
        runThreaded: async () => events.push('threaded'),
        log: (message: string) => events.push(message),
      }),
    ).rejects.toThrow('threaded artifact missing')
    expect(events).toEqual(['scalar'])
  })

  it('sets a nonzero exit code for eligible threaded init failure', async () => {
    const errors: string[] = []
    const processState = { exitCode: 0 }
    const result = await runBenchmarkCli(
      () =>
        runBenchmarkGate({
          eligibility: eligible,
          runScalar: async () => undefined,
          initializeThreaded: async () => {
            throw new Error('threaded init failed')
          },
          runThreaded: async () => undefined,
          log: () => {},
        }),
      {
        error: (message: string) => errors.push(message),
        processState,
      },
    )

    expect(result.status).toBe('failed')
    expect(processState.exitCode).toBe(1)
    expect(errors).toEqual(['STATUS: FAILED: Error: threaded init failed'])
  })

  it('prints DONE only after successful worker cleanup', async () => {
    const events: string[] = []
    const result = await runBenchmarkGate({
      eligibility: eligible,
      runScalar: async () => events.push('scalar'),
      initializeThreaded: async () => ({
        cleanup: async () => events.push('cleanup'),
      }),
      runThreaded: async () => events.push('threaded'),
      log: (message: string) => events.push(message),
    })

    expect(result.status).toBe('done')
    expect(events).toEqual(['scalar', 'threaded', 'cleanup', 'STATUS: DONE'])
  })

  it('fails cleanup without printing DONE', async () => {
    const events: string[] = []
    await expect(
      runBenchmarkGate({
        eligibility: eligible,
        runScalar: async () => events.push('scalar'),
        initializeThreaded: async () => ({
          cleanup: async () => {
            events.push('cleanup')
            throw new Error('worker termination failed')
          },
        }),
        runThreaded: async () => events.push('threaded'),
        log: (message: string) => events.push(message),
      }),
    ).rejects.toThrow('worker termination failed')
    expect(events).toEqual(['scalar', 'threaded', 'cleanup'])
  })

  it('hashes and validates every timed sample outside the timer', async () => {
    let healthChecks = 0
    const output = {
      count: 1,
      pairs: new Uint32Array([0, 1]),
      jimages: new Int8Array([0, 0, 0]),
      lengths: new Float32Array([1.5]),
      strengths: new Float32Array([1]),
    }
    const result = await measureDeterministicSamples({
      label: 'fixture',
      backend: 'scalar',
      run: () => output,
      checkHealth: async () => {
        healthChecks += 1
      },
    })

    expect(result.sampleHashes).toHaveLength(7)
    expect(new Set(result.sampleHashes).size).toBe(1)
    expect(healthChecks).toBe(9)
  })

  it('rejects a mismatch in the final timed threaded sample', async () => {
    let calls = 0
    await expect(
      measureDeterministicSamples({
        label: 'fixture',
        backend: 'threaded',
        run: () => {
          calls += 1
          return {
            count: 1,
            pairs: new Uint32Array([0, 1]),
            jimages: new Int8Array([0, 0, 0]),
            lengths: new Float32Array([1.5]),
            strengths: new Float32Array([calls === 9 ? 2 : 1]),
          }
        },
      }),
    ).rejects.toThrow('fixture threaded timed sample 7: strengths bytes differ')
    expect(calls).toBe(9)
  })

  it('falls back to legacy pkg only when pkg-scalar is missing', async () => {
    const calls: string[] = []
    const missing = Object.assign(
      new Error("Cannot find module '/tmp/pkg-scalar/ferrox.js'"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    const legacyPkg = { detect_bonds_radii_typed: () => undefined }
    const loaded = await initializeScalarArtifact(async (directory: string) => {
      calls.push(directory)
      if (directory === 'pkg-scalar') throw missing
      return legacyPkg
    })

    expect(calls).toEqual(['pkg-scalar', 'pkg'])
    expect(loaded).toEqual({ directory: 'pkg', pkg: legacyPkg })
  })

  it('falls back when the named scalar wasm entry is missing', async () => {
    const calls: string[] = []
    const missing = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open " +
          "'/tmp/pkg-scalar/ferrox_bg.wasm'",
      ),
      {
        code: 'ENOENT',
        path: '/tmp/pkg-scalar/ferrox_bg.wasm',
      },
    )
    const legacyPkg = { detect_bonds_radii_typed: () => undefined }
    const loaded = await initializeScalarArtifact(async (directory: string) => {
      calls.push(directory)
      if (directory === 'pkg-scalar') throw missing
      return legacyPkg
    })

    expect(calls).toEqual(['pkg-scalar', 'pkg'])
    expect(loaded).toEqual({ directory: 'pkg', pkg: legacyPkg })
  })

  it('fails when pkg-scalar has a missing transitive module', async () => {
    const calls: string[] = []
    const events: string[] = []
    const processState = { exitCode: 0 }
    const transitiveMissing = Object.assign(
      new Error(
        "Cannot find module '/tmp/pkg-scalar/snippets/missing.js' imported from " +
          "'/tmp/pkg-scalar/ferrox.js'",
      ),
      {
        code: 'ERR_MODULE_NOT_FOUND',
        url: 'file:///tmp/pkg-scalar/snippets/missing.js',
      },
    )

    const result = await runBenchmarkCli(
      () =>
        runBenchmarkGate({
          eligibility: eligible,
          runScalar: () =>
            initializeScalarArtifact(async (directory: string) => {
              calls.push(directory)
              if (directory === 'pkg-scalar') throw transitiveMissing
              return { detect_bonds_radii_typed: () => undefined }
            }),
          initializeThreaded: async () => ({
            cleanup: async () => events.push('cleanup'),
          }),
          runThreaded: async () => events.push('threaded'),
          log: (message: string) => events.push(message),
        }),
      {
        error: (message: string) => events.push(message),
        processState,
      },
    )

    expect(result.status).toBe('failed')
    expect(processState.exitCode).toBe(1)
    expect(calls).toEqual(['pkg-scalar'])
    expect(events).toEqual([
      'STATUS: FAILED: Error: Cannot find module ' +
        "'/tmp/pkg-scalar/snippets/missing.js' imported from " +
        "'/tmp/pkg-scalar/ferrox.js'",
    ])
    expect(events.join('\n')).not.toMatch(/DONE/)
  })

  it(
    'does not hide a broken pkg-scalar initialization behind legacy fallback',
    async () => {
      const calls: string[] = []
      await expect(
        initializeScalarArtifact(async (directory: string) => {
          calls.push(directory)
          throw new Error('wasm compile failed')
        }),
      ).rejects.toThrow('wasm compile failed')
      expect(calls).toEqual(['pkg-scalar'])
    },
  )
})
