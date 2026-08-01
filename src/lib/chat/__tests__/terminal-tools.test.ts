import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  run_command: vi.fn(),
  send_keys: vi.fn(),
  read_buffer: vi.fn(() => `terminal output`),
  ensure_active_terminal: vi.fn(),
}))

vi.mock(`$lib/api/config`, () => ({ API_BASE: `http://test/api` }))
vi.mock(`$lib/structure/terminal-registry.svelte`, () => ({
  ensure_active_terminal: mocks.ensure_active_terminal,
}))

import { TERMINAL_TOOLS } from '../terminal-tools'

const run_tool = TERMINAL_TOOLS.find((entry) => entry.def.name === `run_command`)!
const send_keys_tool = TERMINAL_TOOLS.find((entry) => entry.def.name === `send_keys`)!

function json_response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': `application/json` },
  })
}

function precheck(decision: `allow` | `prompt` | `forbidden`, reason = ``): Response {
  return json_response({ decision, reason, guarded: decision !== `allow` })
}

describe(`client-direct terminal verification`, () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.run_command.mockReset().mockResolvedValue({ output: `ok`, exit_code: 0 })
    mocks.send_keys.mockReset().mockResolvedValue(undefined)
    mocks.read_buffer.mockReset().mockReturnValue(`terminal output`)
    mocks.ensure_active_terminal.mockReset().mockResolvedValue({
      id: `terminal-1`,
      session_id: `ssh-1`,
      host: `cluster`,
      is_remote: true,
      run_command: mocks.run_command,
      send_keys: mocks.send_keys,
      read_buffer: mocks.read_buffer,
    })
  })

  it(`keeps PTY mutations on the human PermissionCard path`, () => {
    expect(run_tool.def.kind).toBe(`mutate`)
    expect(send_keys_tool.def.kind).toBe(`mutate`)
  })

  it.each([
    `sbatch job.sh`,
    `/opt/slurm/bin/sbatch job.sh`,
    `bash -lc 'sbatch job.sh'`,
    `env FOO=1 /usr/bin/qsub job.pbs`,
    `sudo -u alice bsub < job.lsf`,
    `ssh cluster '/usr/bin/sbatch job.sh'`,
    `printf 'job\\n' | xargs -n 1 qsub`,
    `parallel -j 2 sbatch ::: a.sh b.sh`,
    `watch -n 2 sbatch job.sh`,
  ])(`blocks backend-classified scheduler command before PTY dispatch: %s`, async (command) => {
    const fetch_mock = vi.spyOn(globalThis, `fetch`).mockResolvedValue(
      precheck(`forbidden`, `BLOCKED: pending numeric result`),
    )

    await expect(run_tool.run({ command }, { tab_id: `panel-a` })).rejects.toThrow(`BLOCKED`)
    expect(mocks.ensure_active_terminal).not.toHaveBeenCalled()
    expect(mocks.run_command).not.toHaveBeenCalled()

    const [url, init] = fetch_mock.mock.calls[0]
    expect(url).toBe(`http://test/api/terminal/verification-precheck`)
    expect((init?.headers as Record<string, string>)[`X-CatGo-Tab-Id`]).toBe(`panel-a`)
    expect(JSON.parse(String(init?.body))).toMatchObject({
      action: `run`, command, panel_id: `panel-a`,
    })
  })

  it.each([
    `squeue -u $USER`,
    `qstat -u $USER`,
    `sacct -j 123`,
    `tail -n 50 slurm-123.out`,
    `grep sbatch scheduler.log`,
  ])(`allows backend-classified diagnostics after precheck: %s`, async (command) => {
    vi.spyOn(globalThis, `fetch`).mockResolvedValue(precheck(`allow`))
    await expect(run_tool.run({ command }, { tab_id: `panel-a` })).resolves.toMatchObject({
      output: `ok`, target: `remote (cluster)`,
    })
    expect(mocks.run_command).toHaveBeenCalledWith(command)
  })

  it(`blocks scheduler send_keys containing Enter before writing bytes`, async () => {
    const keys = `cd /work && sbatch job.sh<enter>`
    const fetch_mock = vi.spyOn(globalThis, `fetch`).mockResolvedValue(
      precheck(`forbidden`, `BLOCKED: unverified result`),
    )
    await expect(send_keys_tool.run({ keys }, { tab_id: `panel-b` })).rejects.toThrow(`BLOCKED`)
    expect(mocks.send_keys).not.toHaveBeenCalled()
    expect(JSON.parse(String(fetch_mock.mock.calls[0][1]?.body))).toMatchObject({
      action: `send_keys`, keys, panel_id: `panel-b`,
    })
  })

  it(`fails closed when verification precheck is unavailable or malformed`, async () => {
    vi.spyOn(globalThis, `fetch`).mockRejectedValueOnce(new Error(`offline`))
    await expect(run_tool.run({ command: `squeue` }, { tab_id: `panel-a` })).rejects.toThrow(
      `command was not executed`,
    )
    expect(mocks.run_command).not.toHaveBeenCalled()

    vi.spyOn(globalThis, `fetch`).mockResolvedValueOnce(json_response({ decision: `maybe` }))
    await expect(run_tool.run({ command: `squeue` }, { tab_id: `panel-a` })).rejects.toThrow(
      `invalid decision`,
    )
    expect(mocks.run_command).not.toHaveBeenCalled()
  })

  it(`fails closed on prompt without a trusted authenticated override retry`, async () => {
    vi.spyOn(globalThis, `fetch`).mockImplementation(async () => (
      precheck(`prompt`, `Verification override approval required`)
    ))
    await expect(run_tool.run(
      { command: `sbatch job.sh` }, { tab_id: `panel-a` },
    )).rejects.toThrow(`approval required`)
    await expect(send_keys_tool.run(
      { keys: `sbatch job.sh<enter>` }, { tab_id: `panel-a` },
    )).rejects.toThrow(`approval required`)
    expect(mocks.ensure_active_terminal).not.toHaveBeenCalled()
    expect(mocks.run_command).not.toHaveBeenCalled()
    expect(mocks.send_keys).not.toHaveBeenCalled()
  })
})
