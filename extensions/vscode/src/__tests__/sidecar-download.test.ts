import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
} from 'node:http'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test, vi } from 'vitest'

const fsp_test_state = vi.hoisted(() => ({
  open_hook: undefined as (
    | ((
      actual_open: typeof import('node:fs/promises').open,
      ...args: Parameters<typeof import('node:fs/promises').open>
    ) => ReturnType<typeof import('node:fs/promises').open>)
    | undefined
  ),
  rename_hook: undefined as (
    | ((
      actual_rename: typeof import('node:fs/promises').rename,
      ...args: Parameters<typeof import('node:fs/promises').rename>
    ) => ReturnType<typeof import('node:fs/promises').rename>)
    | undefined
  ),
  access_hook: undefined as (
    | ((
      actual_access: typeof import('node:fs/promises').access,
      ...args: Parameters<typeof import('node:fs/promises').access>
    ) => ReturnType<typeof import('node:fs/promises').access>)
    | undefined
  ),
  unlink_hook: undefined as (
    | ((
      actual_unlink: typeof import('node:fs/promises').unlink,
      ...args: Parameters<typeof import('node:fs/promises').unlink>
    ) => ReturnType<typeof import('node:fs/promises').unlink>)
    | undefined
  ),
  readdir_hook: undefined as (
    | ((
      actual_readdir: typeof import('node:fs/promises').readdir,
      ...args: Parameters<typeof import('node:fs/promises').readdir>
    ) => ReturnType<typeof import('node:fs/promises').readdir>)
    | undefined
  ),
}))

vi.mock(`node:fs/promises`, async (import_original) => {
  const actual = await import_original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (
      ...args: Parameters<typeof import('node:fs/promises').open>
    ) => {
      const hook = fsp_test_state.open_hook
      return hook ? hook(actual.open, ...args) : actual.open(...args)
    },
    rename: (
      ...args: Parameters<typeof import('node:fs/promises').rename>
    ) => {
      const hook = fsp_test_state.rename_hook
      return hook ? hook(actual.rename, ...args) : actual.rename(...args)
    },
    access: (
      ...args: Parameters<typeof import('node:fs/promises').access>
    ) => {
      const hook = fsp_test_state.access_hook
      return hook ? hook(actual.access, ...args) : actual.access(...args)
    },
    unlink: (
      ...args: Parameters<typeof import('node:fs/promises').unlink>
    ) => {
      const hook = fsp_test_state.unlink_hook
      return hook ? hook(actual.unlink, ...args) : actual.unlink(...args)
    },
    readdir: (
      ...args: Parameters<typeof import('node:fs/promises').readdir>
    ) => {
      const hook = fsp_test_state.readdir_hook
      return hook ? hook(actual.readdir, ...args) : actual.readdir(...args)
    },
  }
})

import * as sidecar from '../sidecar'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION_ROOT = path.resolve(TEST_DIR, `../..`)
const VITEST_ENTRY = createRequire(
  path.join(EXTENSION_ROOT, `package.json`),
).resolve(`vitest/vitest.mjs`)

type SidecarAssetUrls = (
  version: string,
  asset_name: string,
) => { binary: string; checksum: string }
type SidecarCachePath = (
  storage_root: string,
  version: string,
  asset_name: string,
) => string
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
type SidecarFileLockSnapshot = unknown
type InspectSidecarFileLock = (
  destination: string,
) => Promise<SidecarFileLockSnapshot | null>
type ReapStaleSidecarFileLock = (
  destination: string,
  snapshot: SidecarFileLockSnapshot,
  options?: {
    wait_timeout_ms?: number
    stale_after_ms?: number
    poll_interval_ms?: number
  },
) => Promise<boolean>

const api = sidecar as unknown as {
  sidecar_asset_urls?: SidecarAssetUrls
  sidecar_cache_path?: SidecarCachePath
  parse_sidecar_checksum?: ParseSidecarChecksum
  download_verified_sidecar?: DownloadVerifiedSidecar
  download_verified_sidecar_from_origin?: DownloadVerifiedSidecarFromOrigin
  stored_sidecar_is_verified?: StoredSidecarIsVerified
  assert_trusted_sidecar_urls?: AssertTrustedSidecarUrls
  resolve_trusted_sidecar_redirect?: ResolveTrustedSidecarRedirect
  request_same_origin_response?: RequestSameOriginResponse
  with_sidecar_file_lock?: WithSidecarFileLock
  inspect_sidecar_file_lock?: InspectSidecarFileLock
  reap_stale_sidecar_file_lock?: ReapStaleSidecarFileLock
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

function reset_fsp_hooks(): void {
  fsp_test_state.open_hook = undefined
  fsp_test_state.rename_hook = undefined
  fsp_test_state.access_hook = undefined
  fsp_test_state.unlink_hook = undefined
  fsp_test_state.readdir_hook = undefined
}

function injected_io_error(operation: string): Error & { code: string } {
  return Object.assign(
    new Error(`injected ${operation} failure`),
    { code: `EIO` },
  )
}

function lock_owner_path(lock_path: string, token: string): string {
  return path.join(lock_path, `owner.${token}.json`)
}

async function single_lock_owner_path(lock_path: string): Promise<string> {
  const owner_entries = (await fsp.readdir(lock_path)).filter((entry) =>
    /^owner\.[A-Za-z0-9-]+\.json$/.test(entry)
  )
  expect(owner_entries).toHaveLength(1)
  return path.join(lock_path, owner_entries[0])
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

  test(`isolates downloaded sidecars by extension version`, () => {
    expect(typeof api.sidecar_cache_path).toBe(`function`)
    if (!api.sidecar_cache_path) return

    const storage_root = path.join(os.tmpdir(), `catgo-storage`)
    const asset_name = `catgo-server-linux-x64`
    const old_cache = api.sidecar_cache_path(
      storage_root,
      `1.4.5`,
      asset_name,
    )
    const current_cache = api.sidecar_cache_path(
      storage_root,
      `1.4.6`,
      asset_name,
    )

    expect(old_cache).toBe(
      path.join(storage_root, `bin`, `v1.4.5`, asset_name),
    )
    expect(current_cache).toBe(
      path.join(storage_root, `bin`, `v1.4.6`, asset_name),
    )
    expect(current_cache).not.toBe(old_cache)
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

  test(`returns no snapshot when the lock directory vanishes during readdir`, async () => {
    expect(typeof api.inspect_sidecar_file_lock).toBe(`function`)
    if (!api.inspect_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    let vanished = false

    try {
      await fsp.mkdir(lock_path)
      fsp_test_state.readdir_hook = async (
        actual_readdir,
        dir_path,
        options,
      ) => {
        if (!vanished && String(dir_path) === lock_path) {
          vanished = true
          await fsp.rmdir(lock_path)
          throw Object.assign(
            new Error(`injected lock directory disappearance`),
            { code: `ENOENT` },
          )
        }
        return await actual_readdir(dir_path, options)
      }

      await expect(
        api.inspect_sidecar_file_lock(destination),
      ).resolves.toBeNull()
      reset_fsp_hooks()
      expect(vanished).toBe(true)
      await expect_absent(lock_path)
    } finally {
      reset_fsp_hooks()
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`returns no stale snapshot when owner open observes a replacement`, async () => {
    expect(typeof api.inspect_sidecar_file_lock).toBe(`function`)
    if (!api.inspect_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const old_owner = lock_owner_path(lock_path, `old-owner`)
    const replacement_owner = lock_owner_path(lock_path, `replacement-owner`)
    let replaced = false

    try {
      await fsp.mkdir(lock_path)
      await fsp.writeFile(old_owner, `${JSON.stringify({
        version: 2,
        pid: process.pid,
        token: `old-owner`,
        created_at: Date.now(),
      })}\n`)
      fsp_test_state.open_hook = async (
        actual_open,
        file_path,
        flags,
        mode,
      ) => {
        if (!replaced && String(file_path) === old_owner) {
          replaced = true
          await fsp.rm(lock_path, { recursive: true })
          await fsp.mkdir(lock_path)
          await fsp.writeFile(replacement_owner, `${JSON.stringify({
            version: 2,
            pid: process.pid,
            token: `replacement-owner`,
            created_at: Date.now(),
          })}\n`)
          throw Object.assign(
            new Error(`injected owner disappearance`),
            { code: `ENOENT` },
          )
        }
        return await actual_open(file_path, flags, mode)
      }

      await expect(
        api.inspect_sidecar_file_lock(destination),
      ).resolves.toBeNull()
      reset_fsp_hooks()
      expect(replaced).toBe(true)
      await expect(
        api.inspect_sidecar_file_lock(destination),
      ).resolves.toMatchObject({
        kind: `owned-directory`,
        record: { token: `replacement-owner` },
      })
      await expect(fsp.readFile(replacement_owner, `utf8`)).resolves.toContain(
        `"token":"replacement-owner"`,
      )
    } finally {
      reset_fsp_hooks()
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`publishes only a fully populated lock directory`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`

    try {
      await api.with_sidecar_file_lock(destination, async () => {
        await expect(fsp.stat(lock_path)).resolves.toMatchObject({
          isDirectory: expect.any(Function),
        })
        expect((await fsp.stat(lock_path)).isDirectory()).toBe(true)
        const owner_path = await single_lock_owner_path(lock_path)
        await expect(fsp.readFile(owner_path, `utf8`)).resolves.toContain(
          `"pid":${process.pid}`,
        )
      })
      await expect_absent(lock_path)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

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
      const owner_path = await single_lock_owner_path(lock_path)
      const expired = new Date(Date.now() - 60_000)
      await fsp.utimes(owner_path, expired, expired)
      await fsp.utimes(lock_path, expired, expired)
      await expect(api.with_sidecar_file_lock(
        destination,
        async () => `unexpected`,
        {
          wait_timeout_ms: 40,
          stale_after_ms: 0,
          poll_interval_ms: 5,
        },
      )).rejects.toThrow(/timed out waiting for sidecar lock/i)
      await expect(fsp.readFile(owner_path, `utf8`)).resolves.toContain(
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
    const owner_path = lock_owner_path(lock_path, `dead-owner`)

    try {
      await fsp.mkdir(lock_path)
      await fsp.writeFile(
        owner_path,
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

  test(`does not reap a replacement lock from a second stale snapshot`, async () => {
    expect(typeof api.inspect_sidecar_file_lock).toBe(`function`)
    expect(typeof api.reap_stale_sidecar_file_lock).toBe(`function`)
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (
      !api.inspect_sidecar_file_lock ||
      !api.reap_stale_sidecar_file_lock ||
      !api.with_sidecar_file_lock
    ) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const owner_path = lock_owner_path(lock_path, `dead-owner`)
    let release_owner: () => void = () => {}
    const owner_release = new Promise<void>((resolve) => {
      release_owner = resolve
    })

    try {
      await fsp.mkdir(lock_path)
      await fsp.writeFile(
        owner_path,
        `${JSON.stringify({
          version: 1,
          pid: 2_147_483_647,
          token: `dead-owner`,
          created_at: 0,
        })}\n`,
      )
      const [first_snapshot, second_snapshot] = await Promise.all([
        api.inspect_sidecar_file_lock(destination),
        api.inspect_sidecar_file_lock(destination),
      ])
      expect(first_snapshot).not.toBeNull()
      expect(second_snapshot).not.toBeNull()
      if (!first_snapshot || !second_snapshot) return

      await expect(api.reap_stale_sidecar_file_lock(
        destination,
        first_snapshot,
        {
          wait_timeout_ms: 100,
          stale_after_ms: 0,
          poll_interval_ms: 5,
        },
      )).resolves.toBe(true)

      let signal_entered: () => void = () => {}
      const entered = new Promise<void>((resolve) => {
        signal_entered = resolve
      })
      const owner = api.with_sidecar_file_lock(destination, async () => {
        signal_entered()
        await owner_release
      })
      await entered

      await expect(api.reap_stale_sidecar_file_lock(
        destination,
        second_snapshot,
        {
          wait_timeout_ms: 100,
          stale_after_ms: 0,
          poll_interval_ms: 5,
        },
      )).resolves.toBe(false)
      const replacement_owner = await single_lock_owner_path(lock_path)
      expect(path.basename(replacement_owner)).not.toBe(
        `owner.dead-owner.json`,
      )
      await expect_absent(owner_path)
      await expect(fsp.readFile(replacement_owner, `utf8`)).resolves.toContain(
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

  test(`does not remove a replacement after an empty-directory cleanup race`, async () => {
    expect(typeof api.inspect_sidecar_file_lock).toBe(`function`)
    expect(typeof api.reap_stale_sidecar_file_lock).toBe(`function`)
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (
      !api.inspect_sidecar_file_lock ||
      !api.reap_stale_sidecar_file_lock ||
      !api.with_sidecar_file_lock
    ) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    let release_owner: () => void = () => {}
    const owner_release = new Promise<void>((resolve) => {
      release_owner = resolve
    })

    try {
      await fsp.mkdir(lock_path)
      const [first_snapshot, second_snapshot] = await Promise.all([
        api.inspect_sidecar_file_lock(destination),
        api.inspect_sidecar_file_lock(destination),
      ])
      expect(first_snapshot).not.toBeNull()
      expect(second_snapshot).not.toBeNull()
      if (!first_snapshot || !second_snapshot) return

      await expect(api.reap_stale_sidecar_file_lock(
        destination,
        first_snapshot,
        { stale_after_ms: 0 },
      )).resolves.toBe(true)

      let signal_entered: () => void = () => {}
      const entered = new Promise<void>((resolve) => {
        signal_entered = resolve
      })
      const owner = api.with_sidecar_file_lock(destination, async () => {
        signal_entered()
        await owner_release
      })
      await entered

      await expect(api.reap_stale_sidecar_file_lock(
        destination,
        second_snapshot,
        { stale_after_ms: 0 },
      )).resolves.toBe(false)
      const replacement_owner = await single_lock_owner_path(lock_path)
      await expect(fsp.readFile(replacement_owner, `utf8`)).resolves.toContain(
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

  test(`treats release as successful when a new owner replaces its emptied directory`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    let finish_first_operation: () => void = () => {}
    let finish_second_operation: () => void = () => {}
    let continue_first_unlink: () => void = () => {}
    let signal_first_entered: () => void = () => {}
    let signal_second_entered: () => void = () => {}
    let signal_first_unlinked: () => void = () => {}
    const first_operation_finished = new Promise<void>((resolve) => {
      finish_first_operation = resolve
    })
    const second_operation_finished = new Promise<void>((resolve) => {
      finish_second_operation = resolve
    })
    const first_unlink_continues = new Promise<void>((resolve) => {
      continue_first_unlink = resolve
    })
    const first_entered = new Promise<void>((resolve) => {
      signal_first_entered = resolve
    })
    const second_entered = new Promise<void>((resolve) => {
      signal_second_entered = resolve
    })
    const first_unlinked = new Promise<void>((resolve) => {
      signal_first_unlinked = resolve
    })
    let first: Promise<string> | undefined
    let second: Promise<string> | undefined

    try {
      first = api.with_sidecar_file_lock(destination, async () => {
        signal_first_entered()
        await first_operation_finished
        return `first completed`
      })
      await first_entered
      const first_owner = await single_lock_owner_path(lock_path)
      fsp_test_state.unlink_hook = async (
        actual_unlink,
        file_path,
      ) => {
        if (String(file_path) === first_owner) {
          await actual_unlink(file_path)
          signal_first_unlinked()
          await first_unlink_continues
          return
        }
        return await actual_unlink(file_path)
      }

      finish_first_operation()
      await first_unlinked
      second = api.with_sidecar_file_lock(destination, async () => {
        signal_second_entered()
        await second_operation_finished
        return `second completed`
      })
      await with_timeout(
        second_entered,
        1_000,
        `replacement owner did not acquire the emptied lock directory`,
      )
      const second_owner = await single_lock_owner_path(lock_path)
      expect(second_owner).not.toBe(first_owner)

      continue_first_unlink()
      await expect(first).resolves.toBe(`first completed`)
      await expect(fsp.readFile(second_owner, `utf8`)).resolves.toContain(
        `"pid":${process.pid}`,
      )

      finish_second_operation()
      await expect(second).resolves.toBe(`second completed`)
      await expect_absent(lock_path)
    } finally {
      finish_first_operation()
      finish_second_operation()
      continue_first_unlink()
      reset_fsp_hooks()
      await Promise.allSettled([
        first ?? Promise.resolve(),
        second ?? Promise.resolve(),
      ])
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`reports a stale reap without disturbing a replacement owner`, async () => {
    expect(typeof api.inspect_sidecar_file_lock).toBe(`function`)
    expect(typeof api.reap_stale_sidecar_file_lock).toBe(`function`)
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (
      !api.inspect_sidecar_file_lock ||
      !api.reap_stale_sidecar_file_lock ||
      !api.with_sidecar_file_lock
    ) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const stale_owner = lock_owner_path(lock_path, `dead-racing-owner`)
    let continue_stale_unlink: () => void = () => {}
    let finish_replacement: () => void = () => {}
    let signal_stale_unlinked: () => void = () => {}
    let signal_replacement_entered: () => void = () => {}
    const stale_unlink_continues = new Promise<void>((resolve) => {
      continue_stale_unlink = resolve
    })
    const replacement_finished = new Promise<void>((resolve) => {
      finish_replacement = resolve
    })
    const stale_unlinked = new Promise<void>((resolve) => {
      signal_stale_unlinked = resolve
    })
    const replacement_entered = new Promise<void>((resolve) => {
      signal_replacement_entered = resolve
    })
    let reap: Promise<boolean> | undefined
    let replacement: Promise<void> | undefined

    try {
      await fsp.mkdir(lock_path)
      await fsp.writeFile(stale_owner, `${JSON.stringify({
        version: 2,
        pid: 2_147_483_647,
        token: `dead-racing-owner`,
        created_at: 0,
      })}\n`)
      const snapshot = await api.inspect_sidecar_file_lock(destination)
      expect(snapshot).not.toBeNull()
      if (!snapshot) return

      fsp_test_state.unlink_hook = async (
        actual_unlink,
        file_path,
      ) => {
        if (String(file_path) === stale_owner) {
          await actual_unlink(file_path)
          signal_stale_unlinked()
          await stale_unlink_continues
          return
        }
        return await actual_unlink(file_path)
      }
      reap = api.reap_stale_sidecar_file_lock(
        destination,
        snapshot,
        { stale_after_ms: 0 },
      )
      await stale_unlinked

      replacement = api.with_sidecar_file_lock(destination, async () => {
        signal_replacement_entered()
        await replacement_finished
      })
      await with_timeout(
        replacement_entered,
        1_000,
        `replacement owner did not acquire during stale reap`,
      )
      const replacement_owner = await single_lock_owner_path(lock_path)
      expect(replacement_owner).not.toBe(stale_owner)

      continue_stale_unlink()
      await expect(reap).resolves.toBe(true)
      await expect(fsp.readFile(replacement_owner, `utf8`)).resolves.toContain(
        `"pid":${process.pid}`,
      )

      finish_replacement()
      await replacement
      await expect_absent(lock_path)
    } finally {
      continue_stale_unlink()
      finish_replacement()
      reset_fsp_hooks()
      await Promise.allSettled([
        reap ?? Promise.resolve(),
        replacement ?? Promise.resolve(),
      ])
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`fails closed when the same lock directory gains extra content`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const extra_path = path.join(lock_path, `unexpected-entry`)
    let finish_operation: () => void = () => {}
    let signal_entered: () => void = () => {}
    const operation_finished = new Promise<void>((resolve) => {
      finish_operation = resolve
    })
    const entered = new Promise<void>((resolve) => {
      signal_entered = resolve
    })
    let owner: Promise<void> | undefined

    try {
      owner = api.with_sidecar_file_lock(destination, async () => {
        signal_entered()
        await operation_finished
      })
      await entered
      const owner_path = await single_lock_owner_path(lock_path)
      fsp_test_state.unlink_hook = async (
        actual_unlink,
        file_path,
      ) => {
        await actual_unlink(file_path)
        if (String(file_path) === owner_path) {
          await fsp.writeFile(extra_path, `preserve for manual cleanup\n`)
        }
      }

      finish_operation()
      await expect(owner).rejects.toThrow(
        /lock directory was not empty after releasing/i,
      )
      reset_fsp_hooks()
      await expect(fsp.readFile(extra_path, `utf8`)).resolves.toContain(
        `manual cleanup`,
      )
    } finally {
      finish_operation()
      reset_fsp_hooks()
      await Promise.allSettled([owner ?? Promise.resolve()])
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`does not reap an expired lock while its PID is still live`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const owner_path = lock_owner_path(
      lock_path,
      `expired-owner-from-reused-pid`,
    )

    try {
      await fsp.mkdir(lock_path)
      await fsp.writeFile(
        owner_path,
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          token: `expired-owner-from-reused-pid`,
          created_at: 0,
          lease_timeout_ms: 5,
        })}\n`,
      )
      const expired = new Date(Date.now() - 60_000)
      await fsp.utimes(owner_path, expired, expired)
      await fsp.utimes(lock_path, expired, expired)

      await expect(api.with_sidecar_file_lock(
        destination,
        async () => `unexpected`,
        {
          wait_timeout_ms: 40,
          stale_after_ms: 5,
          poll_interval_ms: 5,
        },
      )).rejects.toThrow(/timed out waiting for sidecar lock/i)
      await expect(fsp.readFile(owner_path, `utf8`)).resolves.toContain(
        `"token":"expired-owner-from-reused-pid"`,
      )
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`recovers empty and stale malformed lock directories`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const owner_path = lock_owner_path(lock_path, `malformed-owner`)
    const lock_options = {
      wait_timeout_ms: 100,
      stale_after_ms: 5,
      poll_interval_ms: 5,
    }

    try {
      await fsp.mkdir(lock_path)
      await expect(api.with_sidecar_file_lock(
        destination,
        async () => `recovered empty`,
        lock_options,
      )).resolves.toBe(`recovered empty`)
      await expect_absent(lock_path)

      await fsp.mkdir(lock_path)
      await fsp.writeFile(owner_path, `{not valid json`)
      const expired = new Date(Date.now() - 60_000)
      await fsp.utimes(owner_path, expired, expired)
      await fsp.utimes(lock_path, expired, expired)
      await expect(api.with_sidecar_file_lock(
        destination,
        async () => `recovered malformed`,
        lock_options,
      )).resolves.toBe(`recovered malformed`)
      await expect_absent(lock_path)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`ignores an orphaned legacy reaper file`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const reaper_path = `${destination}.lock.reaper`

    try {
      await fsp.writeFile(reaper_path, `orphaned legacy reaper\n`)
      await expect(api.with_sidecar_file_lock(
        destination,
        async () => `completed`,
        {
          wait_timeout_ms: 40,
          stale_after_ms: 0,
          poll_interval_ms: 5,
        },
      )).resolves.toBe(`completed`)
      await expect(fsp.readFile(reaper_path, `utf8`)).resolves.toContain(
        `orphaned legacy reaper`,
      )
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`rejects symlink and legacy-file lock paths without modifying them`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    for (const kind of [`symlink`, `legacy-file`] as const) {
      const temp_dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), `catgo-sidecar-${kind}-`),
      )
      const destination = path.join(temp_dir, `catgo-server-linux-x64`)
      const lock_path = `${destination}.lock`
      const sentinel = path.join(temp_dir, `sentinel`)

      try {
        await fsp.writeFile(sentinel, `preserve me\n`)
        if (kind === `symlink`) {
          const target_dir = path.join(temp_dir, `external-lock-target`)
          await fsp.mkdir(target_dir)
          await fsp.symlink(target_dir, lock_path, `dir`)
        } else {
          await fsp.writeFile(lock_path, `legacy lock\n`)
        }

        await expect(api.with_sidecar_file_lock(
          destination,
          async () => `unexpected`,
          {
            wait_timeout_ms: 40,
            stale_after_ms: 0,
            poll_interval_ms: 5,
          },
        )).rejects.toThrow(/unsafe sidecar lock path.*manual cleanup/i)
        await expect(fsp.readFile(sentinel, `utf8`)).resolves.toBe(
          `preserve me\n`,
        )
        await expect(fsp.lstat(lock_path)).resolves.toBeDefined()
      } finally {
        await fsp.rm(temp_dir, { recursive: true, force: true })
      }
    }
  })

  test(`fails closed when a lock directory has multiple owner entries`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const first_owner = lock_owner_path(lock_path, `first-owner`)
    const second_owner = lock_owner_path(lock_path, `second-owner`)

    try {
      await fsp.mkdir(lock_path)
      await Promise.all([
        fsp.writeFile(first_owner, `${JSON.stringify({
          version: 2,
          pid: process.pid,
          token: `first-owner`,
          created_at: Date.now(),
        })}\n`),
        fsp.writeFile(second_owner, `${JSON.stringify({
          version: 2,
          pid: process.pid,
          token: `second-owner`,
          created_at: Date.now(),
        })}\n`),
      ])

      await expect(api.with_sidecar_file_lock(
        destination,
        async () => `unexpected`,
        {
          wait_timeout_ms: 40,
          stale_after_ms: 0,
          poll_interval_ms: 5,
        },
      )).rejects.toThrow(/unsafe sidecar lock path.*manual cleanup/i)
      await expect(fsp.readFile(first_owner, `utf8`)).resolves.toContain(
        `"token":"first-owner"`,
      )
      await expect(fsp.readFile(second_owner, `utf8`)).resolves.toContain(
        `"token":"second-owner"`,
      )
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`treats EPERM as contention only when the lock directory exists`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const absent_dir = await fsp.mkdtemp(
      path.join(os.tmpdir(), `catgo-sidecar-eperm-absent-`),
    )
    const absent_destination = path.join(absent_dir, `catgo-server-linux-x64`)
    const absent_lock = `${absent_destination}.lock`
    fsp_test_state.rename_hook = async (
      _actual_rename,
      _old_path,
      _new_path,
    ) => {
      throw Object.assign(
        new Error(`injected EPERM with absent target`),
        { code: `EPERM` },
      )
    }
    try {
      await expect(api.with_sidecar_file_lock(
        absent_destination,
        async () => `unexpected`,
      )).rejects.toMatchObject({
        code: `EPERM`,
        message: `injected EPERM with absent target`,
      })
      reset_fsp_hooks()
      expect(
        (await fsp.readdir(absent_dir)).filter((entry) =>
          entry === path.basename(absent_lock) ||
          entry.startsWith(`${path.basename(absent_lock)}.candidate-`)
        ),
      ).toEqual([])
    } finally {
      reset_fsp_hooks()
      await fsp.rm(absent_dir, { recursive: true, force: true })
    }

    const present_dir = await fsp.mkdtemp(
      path.join(os.tmpdir(), `catgo-sidecar-eperm-present-`),
    )
    const present_destination = path.join(present_dir, `catgo-server-linux-x64`)
    const present_lock = `${present_destination}.lock`
    const present_owner = lock_owner_path(present_lock, `live-owner`)
    await fsp.mkdir(present_lock)
    await fsp.writeFile(present_owner, `${JSON.stringify({
      version: 2,
      pid: process.pid,
      token: `live-owner`,
      created_at: Date.now(),
    })}\n`)
    fsp_test_state.rename_hook = async (
      _actual_rename,
      _old_path,
      _new_path,
    ) => {
      throw Object.assign(
        new Error(`injected EPERM with present target`),
        { code: `EPERM` },
      )
    }
    try {
      await expect(api.with_sidecar_file_lock(
        present_destination,
        async () => `unexpected`,
        {
          wait_timeout_ms: 40,
          stale_after_ms: 0,
          poll_interval_ms: 5,
        },
      )).rejects.toThrow(/timed out waiting for sidecar lock.*manual cleanup/i)
      reset_fsp_hooks()
      await expect(fsp.readFile(present_owner, `utf8`)).resolves.toContain(
        `"token":"live-owner"`,
      )
    } finally {
      reset_fsp_hooks()
      await fsp.rm(present_dir, { recursive: true, force: true })
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

  test(`preserves operation and cleanup failures together`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const operation_error = new Error(`primary operation failure`)
    let cleanup_injected = false
    let caught: unknown

    fsp_test_state.unlink_hook = async (
      actual_unlink,
      file_path,
    ) => {
      if (
        !cleanup_injected &&
        path.dirname(String(file_path)) === lock_path &&
        /^owner\.[A-Za-z0-9-]+\.json$/.test(path.basename(String(file_path)))
      ) {
        cleanup_injected = true
        throw injected_io_error(`lock cleanup`)
      }
      return await actual_unlink(file_path)
    }

    try {
      try {
        await api.with_sidecar_file_lock(destination, async () => {
          throw operation_error
        })
      } catch (error) {
        caught = error
      }
      reset_fsp_hooks()

      expect(cleanup_injected).toBe(true)
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).cause).toBe(operation_error)
      const errors = (caught as AggregateError).errors
      expect(errors[0]).toBe(operation_error)
      expect(errors[1]).toMatchObject({
        code: `EIO`,
        message: `injected lock cleanup failure`,
      })
    } finally {
      reset_fsp_hooks()
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`continues candidate cleanup after an acquisition handle-close failure`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_name = `${path.basename(destination)}.lock`
    const primary_error = injected_io_error(`candidate stat`)
    const close_error = Object.assign(
      new Error(`injected candidate close failure`),
      { code: `EACCES` },
    )
    let candidate_path = ``
    let caught: unknown

    fsp_test_state.open_hook = async (
      actual_open,
      file_path,
      flags,
      mode,
    ) => {
      const handle = await actual_open(file_path, flags, mode)
      if (
        String(file_path).includes(`${lock_name}.candidate-`) &&
        /^owner\.[A-Za-z0-9-]+\.json$/.test(path.basename(String(file_path)))
      ) {
        candidate_path = path.dirname(String(file_path))
        return new Proxy(handle, {
          get(target, property) {
            if (property === `stat`) {
              return async () => { throw primary_error }
            }
            if (property === `close`) {
              return async () => {
                await target.close()
                throw close_error
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === `function`
              ? value.bind(target)
              : value
          },
        })
      }
      return handle
    }

    try {
      try {
        await api.with_sidecar_file_lock(
          destination,
          async () => `unexpected`,
        )
      } catch (error) {
        caught = error
      }
      reset_fsp_hooks()

      expect(candidate_path).not.toBe(``)
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).cause).toBe(primary_error)
      expect((caught as AggregateError).errors).toEqual([
        primary_error,
        close_error,
      ])
      await expect_absent(candidate_path)
    } finally {
      reset_fsp_hooks()
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`preserves a lock-owner read failure when closing also fails`, async () => {
    expect(typeof api.inspect_sidecar_file_lock).toBe(`function`)
    if (!api.inspect_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_path = `${destination}.lock`
    const owner_path = lock_owner_path(lock_path, `read-failure-owner`)
    const primary_error = injected_io_error(`owner read`)
    const close_error = Object.assign(
      new Error(`injected owner close failure`),
      { code: `EACCES` },
    )
    let caught: unknown

    try {
      await fsp.mkdir(lock_path)
      await fsp.writeFile(owner_path, `${JSON.stringify({
        version: 2,
        pid: process.pid,
        token: `read-failure-owner`,
        created_at: Date.now(),
      })}\n`)
      fsp_test_state.open_hook = async (
        actual_open,
        file_path,
        flags,
        mode,
      ) => {
        const handle = await actual_open(file_path, flags, mode)
        if (String(file_path) === owner_path) {
          return new Proxy(handle, {
            get(target, property) {
              if (property === `readFile`) {
                return async () => { throw primary_error }
              }
              if (property === `close`) {
                return async () => {
                  await target.close()
                  throw close_error
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === `function`
                ? value.bind(target)
                : value
            },
          })
        }
        return handle
      }

      try {
        await api.inspect_sidecar_file_lock(destination)
      } catch (error) {
        caught = error
      }
      reset_fsp_hooks()

      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).cause).toBe(primary_error)
      expect((caught as AggregateError).errors).toEqual([
        primary_error,
        close_error,
      ])
    } finally {
      reset_fsp_hooks()
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`cleans every acquisition failure without leaking a lock`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const fault_points = [`stat`, `sync`, `rename`, `access`] as const
    for (const fault_point of fault_points) {
      const temp_dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), `catgo-sidecar-${fault_point}-`),
      )
      const destination = path.join(temp_dir, `catgo-server-linux-x64`)
      const lock_name = `${path.basename(destination)}.lock`
      const lock_path = `${destination}.lock`
      let injected = false
      let fault_handle_closed = false

      try {
        if (fault_point === `stat` || fault_point === `sync`) {
          fsp_test_state.open_hook = async (
            actual_open,
            file_path,
            flags,
            mode,
          ) => {
            const handle = await actual_open(file_path, flags, mode)
            if (
              !injected &&
              String(file_path).includes(`${lock_name}.candidate-`) &&
              /^owner\.[A-Za-z0-9-]+\.json$/.test(
                path.basename(String(file_path)),
              )
            ) {
              return new Proxy(handle, {
                get(target, property) {
                  if (property === fault_point) {
                    return async () => {
                      injected = true
                      throw injected_io_error(fault_point)
                    }
                  }
                  if (property === `close`) {
                    return async () => {
                      fault_handle_closed = true
                      return await target.close()
                    }
                  }
                  const value = Reflect.get(target, property, target)
                  return typeof value === `function`
                    ? value.bind(target)
                    : value
                },
              })
            }
            return handle
          }
        } else if (fault_point === `rename`) {
          fsp_test_state.rename_hook = async (
            actual_rename,
            old_path,
            new_path,
          ) => {
            if (
              !injected &&
              String(old_path).includes(`${lock_name}.candidate-`) &&
              String(new_path) === lock_path
            ) {
              injected = true
              throw injected_io_error(fault_point)
            }
            return await actual_rename(old_path, new_path)
          }
        } else {
          fsp_test_state.access_hook = async (
            actual_access,
            file_path,
            mode,
          ) => {
            if (
              !injected &&
              path.dirname(String(file_path)) === lock_path &&
              /^owner\.[A-Za-z0-9-]+\.json$/.test(
                path.basename(String(file_path)),
              )
            ) {
              injected = true
              throw injected_io_error(fault_point)
            }
            return await actual_access(file_path, mode)
          }
        }

        await expect(api.with_sidecar_file_lock(
          destination,
          async () => `unexpected`,
        )).rejects.toMatchObject({
          code: `EIO`,
          message: `injected ${fault_point} failure`,
        })
        reset_fsp_hooks()

        expect(injected).toBe(true)
        if (fault_point === `stat` || fault_point === `sync`) {
          expect(fault_handle_closed).toBe(true)
        }
        expect(
          (await fsp.readdir(temp_dir)).filter((entry) =>
            entry === lock_name ||
            entry.startsWith(`${lock_name}.candidate-`)
          ),
        ).toEqual([])
        await expect(api.with_sidecar_file_lock(
          destination,
          async () => `recovered after ${fault_point}`,
        )).resolves.toBe(`recovered after ${fault_point}`)
        await expect_absent(lock_path)
      } finally {
        reset_fsp_hooks()
        await fsp.rm(temp_dir, { recursive: true, force: true })
      }
    }
  })

  test(`preserves acquisition and candidate-cleanup failures together`, async () => {
    expect(typeof api.with_sidecar_file_lock).toBe(`function`)
    if (!api.with_sidecar_file_lock) return

    const temp_dir = await fsp.mkdtemp(path.join(os.tmpdir(), `catgo-sidecar-`))
    const destination = path.join(temp_dir, `catgo-server-linux-x64`)
    const lock_name = `${path.basename(destination)}.lock`
    let candidate_owner = ``
    let handle_closed = false
    let caught: unknown

    fsp_test_state.open_hook = async (
      actual_open,
      file_path,
      flags,
      mode,
    ) => {
      const handle = await actual_open(file_path, flags, mode)
      if (
        String(file_path).includes(`${lock_name}.candidate-`) &&
        /^owner\.[A-Za-z0-9-]+\.json$/.test(path.basename(String(file_path)))
      ) {
        candidate_owner = String(file_path)
        return new Proxy(handle, {
          get(target, property) {
            if (property === `stat`) {
              return async () => {
                throw injected_io_error(`candidate stat`)
              }
            }
            if (property === `close`) {
              return async () => {
                handle_closed = true
                return await target.close()
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === `function`
              ? value.bind(target)
              : value
          },
        })
      }
      return handle
    }
    fsp_test_state.unlink_hook = async (
      actual_unlink,
      file_path,
    ) => {
      if (candidate_owner && String(file_path) === candidate_owner) {
        throw Object.assign(
          new Error(`injected candidate cleanup failure`),
          { code: `EACCES` },
        )
      }
      return await actual_unlink(file_path)
    }

    try {
      try {
        await api.with_sidecar_file_lock(
          destination,
          async () => `unexpected`,
        )
      } catch (error) {
        caught = error
      }
      reset_fsp_hooks()

      expect(handle_closed).toBe(true)
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).cause).toBe(
        (caught as AggregateError).errors[0],
      )
      const errors = (caught as AggregateError).errors
      expect(errors[0]).toMatchObject({
        code: `EIO`,
        message: `injected candidate stat failure`,
      })
      expect(errors[1]).toMatchObject({
        code: `EACCES`,
        message: `injected candidate cleanup failure`,
      })
    } finally {
      reset_fsp_hooks()
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
