import * as fsp from 'node:fs/promises'
import { createServer, type RequestListener } from 'node:http'
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
type StoredSidecarIsVerified = (
  destination: string,
  asset_name: string,
) => Promise<boolean>

const api = sidecar as unknown as {
  sidecar_asset_urls?: SidecarAssetUrls
  parse_sidecar_checksum?: ParseSidecarChecksum
  download_verified_sidecar?: DownloadVerifiedSidecar
  stored_sidecar_is_verified?: StoredSidecarIsVerified
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

describe(`VS Code sidecar acquisition`, () => {
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
    expect(typeof api.download_verified_sidecar).toBe(`function`)
    if (!api.download_verified_sidecar) return

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
        await api.download_verified_sidecar!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        })
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

  test(`fails closed when checksum metadata is missing`, async () => {
    expect(typeof api.download_verified_sidecar).toBe(`function`)
    if (!api.download_verified_sidecar) return

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
        await expect(api.download_verified_sidecar!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        })).rejects.toThrow(/HTTP 404.*sha256/i)
      })

      expect(binary_requested).toBe(false)
      for (const output of outputs) await expect_absent(output)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`rejects malformed checksum metadata before downloading the binary`, async () => {
    expect(typeof api.download_verified_sidecar).toBe(`function`)
    if (!api.download_verified_sidecar) return

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
        await expect(api.download_verified_sidecar!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        })).rejects.toThrow(/malformed checksum/i)
      })

      expect(binary_requested).toBe(false)
      await expect_absent(destination)
      await expect_absent(`${destination}.partial`)
    } finally {
      await fsp.rm(temp_dir, { recursive: true, force: true })
    }
  })

  test(`removes every output when the binary digest does not match`, async () => {
    expect(typeof api.download_verified_sidecar).toBe(`function`)
    if (!api.download_verified_sidecar) return

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
        await expect(api.download_verified_sidecar!({
          binary_url: `${base_url}/${asset_name}`,
          checksum_url: `${base_url}/${asset_name}.sha256`,
          destination,
          asset_name,
        })).rejects.toThrow(/SHA-256 mismatch/i)
      })

      for (const output of outputs) await expect_absent(output)
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
