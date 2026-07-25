import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
} from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import * as sidecar from '../sidecar'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION_ROOT = path.resolve(TEST_DIR, `../..`)
const VITEST_ENTRY = fileURLToPath(
  new URL(`../vitest.mjs`, import.meta.resolve(`vitest`)),
)

type SidecarAssetUrls = (
  version: string,
  asset_name: string,
) => { binary: string; checksum: string }
type ParseSidecarChecksum = (
  contents: string,
  expected_filename: string,
) => string
type DownloadVerifiedSidecar = (options: {
  binary_url: string
  checksum_url: string
  destination: string
  asset_name: string
  on_progress?: (downloaded: number, total: number | null) => void
}) => Promise<void>
type DownloadVerifiedSidecarFromOrigin = (
  options: Parameters<DownloadVerifiedSidecar>[0],
  expected_origin: string,
) => Promise<void>
type StoredSidecarIsVerified = (
  destination: string,
  asset_name: string,
) => Promise<boolean>
type AssertTrustedSidecarUrls = (
  binary_url: string,
  checksum_url: string,
) => void
type ResolveTrustedSidecarRedirect = (
  current_url: string,
  location: string,
) => string
type RequestSameOriginResponse = (
  url: string,
  expected_origin: string,
) => Promise<IncomingMessage>
type WithSidecarFileLock = <T>(
  destination: string,
  operation: () => Promise<T>,
  options?: {
    wait_timeout_ms?: number
    stale_after_ms?: number
    poll_interval_ms?: number
  },
) => Promise<T>

const api = sidecar as unknown as {
  sidecar_asset_urls?: SidecarAssetUrls
  parse_sidecar_checksum?: ParseSidecarChecksum
  download_verified_sidecar?: DownloadVerifiedSidecar
  download_verified_sidecar_from_origin?: DownloadVerifiedSidecarFromOrigin
  stored_sidecar_is_verified?: StoredSidecarIsVerified
  assert_trusted_sidecar_urls?: AssertTrustedSidecarUrls
  resolve_trusted_sidecar_redirect?: ResolveTrustedSidecarRedirect
  request_same_origin_response?: RequestSameOriginResponse
  with_sidecar_file_lock?: WithSidecarFileLock
}

async function with_server<T>(
  handler: RequestListener,
  run: (base_url: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once(`error`, reject)
    server.listen(0, `127.0.0.1`, resolve)
  })
  const address = server.address()
  if (!address || typeof address === `string`) {
    throw new Error(`Test server did not expose a TCP port`)
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

async function expect_absent(file_path: string): Promise<void> {
  await expect(fsp.access(file_path)).rejects.toMatchObject({ code: `ENOENT` })
}

async function wait_until(
  predicate: () => Promise<boolean>,
  failure_message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(failure_message)
}

type ChildResult = {
  code: number | null
  stdout: string
  stderr: string
}

function spawn_sidecar_child(
  mode: `success` | `failure`,
  environment: {
    base_url: string
    destination: string
    asset_name: string
  },
): { child: ChildProcess; result: Promise<ChildResult> } {
  const child = spawn(
    process.execPath,
    [
      VITEST_ENTRY,
      `run`,
      `src/__tests__/fixtures/sidecar-download-process.test.ts`,
    ],
    {
      cwd: EXTENSION_ROOT,
      env: {
        ...process.env,
        NO_COLOR: `1`,
        CATGO_SIDECAR_CHILD_MODE: mode,
        CATGO_SIDECAR_CHILD_BASE_URL: environment.base_url,
        CATGO_SIDECAR_CHILD_DESTINATION: environment.destination,
        CATGO_SIDECAR_CHILD_ASSET_NAME: environment.asset_name,
      },
      stdio: [`ignore`, `pipe`, `pipe`],
    },
  )
  let stdout = ``
  let stderr = ``
  child.stdout?.setEncoding(`utf8`)
  child.stderr?.setEncoding(`utf8`)
  child.stdout?.on(`data`, (chunk: string) => { stdout += chunk })
  child.stderr?.on(`data`, (chunk: string) => { stderr += chunk })

  const result = new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill(`SIGKILL`)
      reject(new Error(`Sidecar ${mode} child process timed out`))
    }, 15_000)
    child.once(`error`, (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once(`close`, (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
  return { child, result }
}

async function with_timeout<T>(
  promise: Promise<T>,
  timeout_ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout_ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe(`VS Code sidecar acquisition`, () => {
  test(`allows only HTTPS dl.catgo-ucsd.org initial URLs for both assets`, () => {
    expect(typeof api.assert_trusted_sidecar_urls).toBe(`function`)
    if (!api.assert_trusted_sidecar_urls) return

    const asset = `catgo-server-linux-x64`
    const binary = `https://dl.catgo-ucsd.org/v1.4.6/${asset}`
    const checksum = `${binary}.sha256`
    expect(() => api.assert_trusted_sidecar_urls!(
      binary,
      checksum,
    )).not.toThrow()

    const untrusted_pairs = [
      [`http://dl.catgo-ucsd.org/v1.4.6/${asset}`, checksum],
      [`https://evil.example/v1.4.6/${asset}`, checksum],
      [`https://dl.catgo-ucsd.org.evil.example/v1.4.6/${asset}`, checksum],
      [`https://user@dl.catgo-ucsd.org/v1.4.6/${asset}`, checksum],
      [`https://dl.catgo-ucsd.org:444/v1.4.6/${asset}`, checksum],
      [binary, `http://dl.catgo-ucsd.org/v1.4.6/${asset}.sha256`],
      [binary, `https://evil.example/v1.4.6/${asset}.sha256`],
      [binary, `not a URL`],
    ]
    for (const [candidate_binary, candidate_checksum] of untrusted_pairs) {
      expect(() => api.assert_trusted_sidecar_urls!(
        candidate_binary,
        candidate_checksum,
      )).toThrow(/trusted HTTPS sidecar origin/i)
    }
  })

  test(`allows only same-origin HTTPS redirects with valid Location values`, () => {
    expect(typeof api.resolve_trusted_sidecar_redirect).toBe(`function`)
    if (!api.resolve_trusted_sidecar_redirect) return

    const current =
      `https://dl.catgo-ucsd.org/v1.4.6/catgo-server-linux-x64`
    expect(
      api.resolve_trusted_sidecar_redirect(current, `./objects/sidecar`),
    ).toBe(`https://dl.catgo-ucsd.org/v1.4.6/objects/sidecar`)

    for (const location of [
      `http://dl.catgo-ucsd.org/sidecar`,
      `https://evil.example/sidecar`,
      `https://dl.catgo-ucsd.org.evil.example/sidecar`,
      `https://dl.catgo-ucsd.org:444/sidecar`,
      `http://[::1`,
    ]) {
      expect(() => api.resolve_trusted_sidecar_redirect!(
        current,
        location,
      )).toThrow(/trusted HTTPS sidecar origin|malformed redirect/i)
    }
  })

  test(`rejects a malformed HTTP Location through the request promise`, async () => {
    expect(typeof api.request_same_origin_response).toBe(`function`)
    if (!api.request_same_origin_response) return

    await with_server((_request, response) => {
      response.writeHead(302, { Location: `http://[::1` })
      response.end()
    }, async (base_url) => {
      await expect(
        api.request_same_origin_response!(`${base_url}/start`, base_url),
      ).rejects.toThrow(/malformed redirect/i)
    })
  })

  test(`does not follow an HTTP redirect to another origin`, async () => {
    expect(typeof api.request_same_origin_response).toBe(`function`)
    if (!api.request_same_origin_response) return

    let target_requests = 0
    await with_server((_request, response) => {
      target_requests += 1
      response.writeHead(200)
      response.end(`unexpected`)
    }, async (target_origin) => {
      await with_server((_request, response) => {
        response.writeHead(302, { Location: `${target_origin}/sidecar` })
        response.end()
      }, async (source_origin) => {
        await expect(
          api.request_same_origin_response!(
            `${source_origin}/start`,
            source_origin,
          ),
        ).rejects.toThrow(/escaped the expected origin/i)
      })
    })
    expect(target_requests).toBe(0)
  })

  test(`rejects untrusted download URLs before either asset is requested`, async () => {
    expect(typeof api.download_verified_sidecar).toBe(`function`)
    if (!api.download_verified_sidecar) return

    const asset_name = `catgo-server-linux-x64`
    const body = `verified sidecar\n`
    const digest = `63ce0212769a70e03da7aae4b05a45c1cbdea457c44b63caffbe00714bd0c0e4`
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)
    let requests = 0

    try {
      await with_server((request, response) => {
        requests += 1
        response.writeHead(200)
        response.end(
          request.url?.endsWith(`.sha256`)
            ? `${digest}  ${asset_name}\n`
            : body,
        )
      }, async (base_url) => {
        await expect(api.download_verified_sidecar!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        })).rejects.toThrow(/trusted HTTPS sidecar origin/i)
      })

      expect(requests).toBe(0)
      await expect_absent(destination)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`builds version-coupled Cloudflare binary and checksum URLs`, () => {
    expect(typeof api.sidecar_asset_urls).toBe(`function`)
    if (!api.sidecar_asset_urls) return

    expect(
      api.sidecar_asset_urls(`1.4.6`, `catgo-server-linux-x64`),
    ).toEqual({
      binary: `https://dl.catgo-ucsd.org/v1.4.6/catgo-server-linux-x64`,
      checksum: `https://dl.catgo-ucsd.org/v1.4.6/catgo-server-linux-x64.sha256`,
    })
  })

  test(`accepts only a checksum bound to the requested asset filename`, () => {
    expect(typeof api.parse_sidecar_checksum).toBe(`function`)
    if (!api.parse_sidecar_checksum) return

    const digest = `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`
    expect(
      api.parse_sidecar_checksum(
        `${digest}  catgo-server-linux-x64\n`,
        `catgo-server-linux-x64`,
      ),
    ).toBe(digest)

    const invalid = [
      `${digest} catgo-server-linux-x64\n`,
      `${digest}  catgo-server-win-x64.exe\n`,
      `${digest}  ../catgo-server-linux-x64\n`,
      `${digest}  catgo-server-linux-x64\nextra`,
      `not-a-sha256  catgo-server-linux-x64\n`,
      ``,
    ]
    for (const contents of invalid) {
      expect(() => api.parse_sidecar_checksum!(
        contents,
        `catgo-server-linux-x64`,
      )).toThrow(/malformed checksum/i)
    }
  })

  test(`downloads and publishes a sidecar only after SHA-256 verification`, async () => {
    expect(typeof api.download_verified_sidecar_from_origin).toBe(`function`)
    if (!api.download_verified_sidecar_from_origin) return

    const asset_name = `catgo-server-linux-x64`
    const body = `verified sidecar\n`
    const digest = `63ce0212769a70e03da7aae4b05a45c1cbdea457c44b63caffbe00714bd0c0e4`
    const requests: string[] = []
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)

    try {
      await with_server((request, response) => {
        requests.push(request.url ?? ``)
        if (request.url === `/${asset_name}.sha256`) {
          response.writeHead(200, { 'Content-Type': `text/plain` })
          response.end(`${digest}  ${asset_name}\n`)
          return
        }
        if (request.url === `/${asset_name}`) {
          response.writeHead(200, {
            'Content-Length': Buffer.byteLength(body),
          })
          response.end(body)
          return
        }
        response.writeHead(404)
        response.end()
      }, async (base_url) => {
        await api.download_verified_sidecar_from_origin!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        }, base_url)
      })

      expect(requests).toEqual([
        `/${asset_name}.sha256`,
        `/${asset_name}`,
      ])
      await expect(fsp.readFile(destination, `utf8`)).resolves.toBe(body)
      await expect(
        fsp.readFile(`${destination}.sha256`, `utf8`),
      ).resolves.toBe(`${digest}  ${asset_name}\n`)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`coalesces concurrent downloads targeting the same sidecar`, async () => {
    expect(typeof api.download_verified_sidecar_from_origin).toBe(`function`)
    if (!api.download_verified_sidecar_from_origin) return

    const asset_name = `catgo-server-linux-x64`
    const body = `verified sidecar\n`
    const digest = `63ce0212769a70e03da7aae4b05a45c1cbdea457c44b63caffbe00714bd0c0e4`
    const requests = { binary: 0, checksum: 0 }
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)

    try {
      await with_server((request, response) => {
        if (request.url?.endsWith(`.sha256`)) {
          requests.checksum += 1
          setTimeout(() => {
            response.writeHead(200)
            response.end(`${digest}  ${asset_name}\n`)
          }, 20)
          return
        }
        requests.binary += 1
        response.writeHead(200)
        response.end(body)
      }, async (base_url) => {
        const options = {
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        }
        await Promise.all([
          api.download_verified_sidecar_from_origin!(options, base_url),
          api.download_verified_sidecar_from_origin!(options, base_url),
        ])
      })

      expect(requests).toEqual({ binary: 1, checksum: 1 })
      await expect(fsp.readFile(destination, `utf8`)).resolves.toBe(body)
      await expect(
        fsp.readFile(`${destination}.sha256`, `utf8`),
      ).resolves.toBe(`${digest}  ${asset_name}\n`)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`uses a unique temporary file for each publication attempt`, async () => {
    expect(typeof api.download_verified_sidecar_from_origin).toBe(`function`)
    if (!api.download_verified_sidecar_from_origin) return

    const asset_name = `catgo-server-linux-x64`
    const digest = `63ce0212769a70e03da7aae4b05a45c1cbdea457c44b63caffbe00714bd0c0e4`
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)
    let signal_binary_started: () => void = () => {}
    let release_binary: () => void = () => {}
    const binary_started = new Promise<void>((resolve) => {
      signal_binary_started = resolve
    })
    const binary_release = new Promise<void>((resolve) => {
      release_binary = resolve
    })

    try {
      await with_server((request, response) => {
        if (request.url?.endsWith(`.sha256`)) {
          response.writeHead(200)
          response.end(`${digest}  ${asset_name}\n`)
          return
        }
        response.writeHead(200)
        response.write(`verified `)
        signal_binary_started()
        void binary_release.then(() => response.end(`sidecar\n`))
      }, async (base_url) => {
        const download = api.download_verified_sidecar_from_origin!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        }, base_url)

        await binary_started
        await wait_until(
          async () => (await fsp.readdir(temp_dir))
            .some((entry) => entry.endsWith(`.partial`)),
          `download did not create a temporary file`,
        )
        try {
          const entries = await fsp.readdir(temp_dir)
          expect(entries).not.toContain(`${asset_name}.partial`)
          expect(
            entries.filter((entry) =>
              entry.startsWith(`${asset_name}.`) &&
              entry.endsWith(`.partial`)
            ),
          ).toHaveLength(1)
        } finally {
          release_binary()
          await download
        }
      })
    } finally {
      release_binary()
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`coordinates cache validation with an active publication`, async () => {
    expect(typeof api.download_verified_sidecar_from_origin).toBe(`function`)
    expect(typeof api.stored_sidecar_is_verified).toBe(`function`)
    if (
      !api.download_verified_sidecar_from_origin ||
      !api.stored_sidecar_is_verified
    ) return

    const asset_name = `catgo-server-linux-x64`
    const body = `verified sidecar\n`
    const digest = `63ce0212769a70e03da7aae4b05a45c1cbdea457c44b63caffbe00714bd0c0e4`
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)
    let signal_binary_started: () => void = () => {}
    let release_binary: () => void = () => {}
    const binary_started = new Promise<void>((resolve) => {
      signal_binary_started = resolve
    })
    const binary_release = new Promise<void>((resolve) => {
      release_binary = resolve
    })

    try {
      await with_server((request, response) => {
        if (request.url?.endsWith(`.sha256`)) {
          response.writeHead(200)
          response.end(`${digest}  ${asset_name}\n`)
          return
        }
        response.writeHead(200)
        response.write(`verified `)
        signal_binary_started()
        void binary_release.then(() => response.end(`sidecar\n`))
      }, async (base_url) => {
        const download = api.download_verified_sidecar_from_origin!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        }, base_url)

        await binary_started
        const validation = api.stored_sidecar_is_verified!(
          destination,
          asset_name,
        )
        const validation_state = await Promise.race([
          validation.then(() => `settled`),
          new Promise((resolve) => setTimeout(() => resolve(`pending`), 20)),
        ])
        release_binary()
        await expect(download).resolves.toBeUndefined()
        expect(validation_state).toBe(`pending`)
        await expect(validation).resolves.toBe(true)
        await expect(fsp.readFile(destination, `utf8`)).resolves.toBe(body)
      })
    } finally {
      release_binary()
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`preserves a successful cache across independent extension-host processes`, async () => {
    const asset_name = `catgo-server-linux-x64`
    const body = `verified sidecar\n`
    const digest = `63ce0212769a70e03da7aae4b05a45c1cbdea457c44b63caffbe00714bd0c0e4`
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)
    let signal_success_started: () => void = () => {}
    let signal_failure_started: () => void = () => {}
    let release_success: () => void = () => {}
    let release_failure: () => void = () => {}
    const success_started = new Promise<void>((resolve) => {
      signal_success_started = resolve
    })
    const failure_started = new Promise<void>((resolve) => {
      signal_failure_started = resolve
    })
    const success_release = new Promise<void>((resolve) => {
      release_success = resolve
    })
    const failure_release = new Promise<void>((resolve) => {
      release_failure = resolve
    })
    let success_child: ChildProcess | undefined
    let failure_child: ChildProcess | undefined
    let failure_requests = 0

    try {
      await with_server((request, response) => {
        const request_url = request.url ?? ``
        const is_failure = request_url.startsWith(`/failure/`)
        if (is_failure) failure_requests += 1

        if (request_url.endsWith(`.sha256`)) {
          response.writeHead(200)
          response.end(`${digest}  ${asset_name}\n`)
          return
        }
        if (is_failure) {
          response.writeHead(200)
          response.write(`tampered `)
          signal_failure_started()
          void failure_release.then(() => response.end(`sidecar\n`))
          return
        }
        response.writeHead(200)
        response.write(`verified `)
        signal_success_started()
        void success_release.then(() => response.end(`sidecar\n`))
      }, async (base_url) => {
        const child_environment = { base_url, destination, asset_name }
        const success = spawn_sidecar_child(`success`, child_environment)
        success_child = success.child
        await with_timeout(
          success_started,
          5_000,
          `Success child never began its binary download`,
        )

        const failure = spawn_sidecar_child(`failure`, child_environment)
        failure_child = failure.child
        const failure_started_before_publish = await Promise.race([
          failure_started.then(() => true),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), 2_000)
          }),
        ])

        release_success()
        const success_result = await success.result
        release_failure()
        const failure_result = await failure.result

        expect(
          success_result.code,
          `${success_result.stdout}\n${success_result.stderr}`,
        ).toBe(0)
        expect(failure_started_before_publish).toBe(false)
        expect(
          failure_result.code,
          `${failure_result.stdout}\n${failure_result.stderr}`,
        ).toBe(0)
        expect(failure_requests).toBe(0)
        await expect(fsp.readFile(destination, `utf8`)).resolves.toBe(body)
        await expect(
          fsp.readFile(`${destination}.sha256`, `utf8`),
        ).resolves.toBe(`${digest}  ${asset_name}\n`)
      })
    } finally {
      release_success()
      release_failure()
      if (success_child?.exitCode === null) success_child.kill(`SIGKILL`)
      if (failure_child?.exitCode === null) failure_child.kill(`SIGKILL`)
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  }, 25_000)

  test(`bounds lock waiting without stealing a live owner's lock`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    let signal_entered: () => void = () => {}
    let release_owner: () => void = () => {}
    const entered = new Promise<void>((resolve) => {
      signal_entered = resolve
    })
    const owner_release = new Promise<void>((resolve) => {
      release_owner = resolve
    })

    try {
      const owner = api.with_sidecar_file_lock(destination, async () => {
        signal_entered()
        await owner_release
      })
      await entered
      await expect(api.with_sidecar_file_lock(
        destination,
        async () => `unexpected`,
        {
          wait_timeout_ms: 40,
          stale_after_ms: 5,
          poll_interval_ms: 5,
        },
      )).rejects.toThrow(/timed out waiting for sidecar lock/i)
      await expect(fsp.readFile(lock_path, `utf8`)).resolves.toContain(
        `"pid":${process.pid}`,
      )
      release_owner()
      await owner
      await expect_absent(lock_path)
    } finally {
      release_owner()
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`recovers a lock whose owner process no longer exists`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`

    try {
      await fsp.writeFile(
        lock_path,
        `${JSON.stringify({
          version: 1,
          pid: 2_147_483_647,
          token: `dead-owner`,
          created_at: 0,
        })}\n`,
      )
      await expect(api.with_sidecar_file_lock(
        destination,
        async () => `recovered`,
        {
          wait_timeout_ms: 100,
          stale_after_ms: 0,
          poll_interval_ms: 5,
        },
      )).resolves.toBe(`recovered`)
      await expect_absent(lock_path)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`releases the filesystem lock when the protected operation rejects`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`

    try {
      await expect(api.with_sidecar_file_lock(destination, async () => {
        throw new Error(`intentional operation failure`)
      })).rejects.toThrow(/intentional operation failure/)
      await expect_absent(lock_path)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`fails closed when checksum metadata is missing`, async () => {
    expect(typeof api.download_verified_sidecar_from_origin).toBe(`function`)
    if (!api.download_verified_sidecar_from_origin) return

    const asset_name = `catgo-server-linux-x64`
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)
    const outputs = [
      destination,
      `${destination}.partial`,
      `${destination}.sha256`,
      `${destination}.sha256.partial`,
    ]
    let binary_requested = false

    try {
      await fsp.writeFile(destination, `stale executable`)
      await fsp.chmod(destination, 0o755)
      await fsp.writeFile(`${destination}.partial`, `partial`)

      await with_server((request, response) => {
        if (request.url === `/${asset_name}`) binary_requested = true
        response.writeHead(404)
        response.end()
      }, async (base_url) => {
        await expect(api.download_verified_sidecar_from_origin!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        }, base_url)).rejects.toThrow(/HTTP 404.*sha256/i)
      })

      expect(binary_requested).toBe(false)
      for (const output of outputs) await expect_absent(output)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`rejects malformed checksum metadata before downloading the binary`, async () => {
    expect(typeof api.download_verified_sidecar_from_origin).toBe(`function`)
    if (!api.download_verified_sidecar_from_origin) return

    const asset_name = `catgo-server-linux-x64`
    const digest = `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)
    let binary_requested = false

    try {
      await with_server((request, response) => {
        if (request.url === `/${asset_name}`) binary_requested = true
        response.writeHead(200)
        response.end(`${digest} ${asset_name}\n`)
      }, async (base_url) => {
        await expect(api.download_verified_sidecar_from_origin!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        }, base_url)).rejects.toThrow(/malformed checksum/i)
      })

      expect(binary_requested).toBe(false)
      await expect_absent(destination)
      await expect_absent(`${destination}.partial`)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`removes every output when the binary digest does not match`, async () => {
    expect(typeof api.download_verified_sidecar_from_origin).toBe(`function`)
    if (!api.download_verified_sidecar_from_origin) return

    const asset_name = `catgo-server-linux-x64`
    const digest = `63ce0212769a70e03da7aae4b05a45c1cbdea457c44b63caffbe00714bd0c0e4`
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)
    const outputs = [
      destination,
      `${destination}.partial`,
      `${destination}.sha256`,
      `${destination}.sha256.partial`,
    ]

    try {
      await with_server((request, response) => {
        response.writeHead(200)
        if (request.url?.endsWith(`.sha256`)) {
          response.end(`${digest}  ${asset_name}\n`)
        } else {
          response.end(`tampered sidecar\n`)
        }
      }, async (base_url) => {
        await expect(api.download_verified_sidecar_from_origin!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        }, base_url)).rejects.toThrow(/SHA-256 mismatch/i)
      })

      for (const output of outputs) await expect_absent(output)
      expect(
        (await fsp.readdir(temp_dir))
          .filter((entry) => entry.endsWith(`.partial`)),
      ).toEqual([])
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`revalidates cached sidecars and removes stale executables`, async () => {
    expect(typeof api.stored_sidecar_is_verified).toBe(`function`)
    if (!api.stored_sidecar_is_verified) return

    const asset_name = `catgo-server-linux-x64`
    const body = `verified sidecar\n`
    const digest = `63ce0212769a70e03da7aae4b05a45c1cbdea457c44b63caffbe00714bd0c0e4`
    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, asset_name)

    try {
      await fsp.writeFile(destination, body)
      await fsp.writeFile(
        `${destination}.sha256`,
        `${digest}  ${asset_name}\n`,
      )
      await expect(
        api.stored_sidecar_is_verified(destination, asset_name),
      ).resolves.toBe(true)
      await expect(fsp.readFile(destination, `utf8`)).resolves.toBe(body)

      await fsp.writeFile(destination, `tampered sidecar\n`)
      await expect(
        api.stored_sidecar_is_verified(destination, asset_name),
      ).resolves.toBe(false)
      await expect_absent(destination)
      await expect_absent(`${destination}.sha256`)

      await fsp.writeFile(destination, body)
      await fsp.chmod(destination, 0o755)
      await expect(
        api.stored_sidecar_is_verified(destination, asset_name),
      ).resolves.toBe(false)
      await expect_absent(destination)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })
})
