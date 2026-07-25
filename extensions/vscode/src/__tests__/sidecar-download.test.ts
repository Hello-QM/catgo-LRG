import * as fsp from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
} from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, test } from 'vitest'

import * as sidecar from '../sidecar'

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

const api = sidecar as unknown as {
  sidecar_asset_urls?: SidecarAssetUrls
  parse_sidecar_checksum?: ParseSidecarChecksum
  download_verified_sidecar?: DownloadVerifiedSidecar
  download_verified_sidecar_from_origin?: DownloadVerifiedSidecarFromOrigin
  stored_sidecar_is_verified?: StoredSidecarIsVerified
  assert_trusted_sidecar_urls?: AssertTrustedSidecarUrls
  resolve_trusted_sidecar_redirect?: ResolveTrustedSidecarRedirect
  request_same_origin_response?: RequestSameOriginResponse
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
