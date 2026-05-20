# CatGO CLI — `catgo submit` (HPC input + SLURM submit)

Slice D of the P3 backlog. Builds on P3b (`feature/catgo-cli-cleanup`,
PR catgo-dev#3); stacked PR base = that branch.

## Goal

`catgo submit <input> [--code vasp|cp2k] [--host <profile>] [--queue <name>]
[--walltime <H>] [--nodes <N>] [--remote-dir <path>] [--no-autostart]` —
generate the requested code's input deck for the active session structure
(or the `<input>` file argument), `scp` it to a remote HPC host, and
`sbatch` it. Print the remote job id + a `squeue` watchpoint hint.

## Why this is its own slice (and how it relates to existing infra)

`server/catgo/routers/hpc.py` already wraps the full SSH/SLURM/scp story,
but every endpoint is **session-based**: every call requires a
`session_id` from a connected `pool` (`HPCConnectionPool`), and the
only way to obtain one is the WebSocket `/hpc/connect` (with password
+ OTP prompts) or the `connect_ssh_config` REST endpoint that spawns
the system `ssh` binary in ControlMaster mode.

P1–P3a's in-process adapter (`adapter.call_route`) pattern is therefore
**not a good fit** for `catgo submit`:

- WebSocket auth + interactive OTP is impossible to drive headlessly.
- Even if the CLI used the REST `connect_ssh_config` route directly,
  the pool's `HPCConnection` is event-loop-bound (`_owner_loop`) and
  the asyncssh / SFTP machinery wants to live for the duration of the
  process — heavyweight for one fire-and-forget submission.

Both `connect_ssh_config` and every existing file-op fall back to the
same primitive: `subprocess_exec(["ssh", alias, …])`. The CLI does the
same thing directly, synchronously, via stdlib `subprocess` — same idea
as P3a using stdlib `urllib.request` instead of `httpx`. No new
dependency, no async/loop juggling, no need to mock asyncssh in tests.

We reuse the **two input-generation FastAPI routes** in-process via the
existing `adapter.call_route` (`POST /vasp/generate` and `POST /cp2k/input`)
because those ARE synchronous, deterministic functions with no I/O. The
only outbound network call is the ssh/scp/sbatch invocation.

We reuse the **existing profile file** `~/.catgo/hpc_profiles.json` as
the authoritative source of host config (no new auth scheme, no new file
format). The CLI loads it via `connection_pool.load_profiles` and only
accepts profiles whose `auth_method` is one of:

- `ssh_config` — uses the user's `~/.ssh/config` alias (ControlMaster);
  zero credentials needed.
- `key` — uses the key file recorded in the profile (BatchMode prevents
  any interactive prompt).

Profiles requiring `password`, `password_otp`, or `key_otp` fail with a
clean OpError telling the user to either set up ControlMaster +
`ssh_config` auth, or connect once via `catgo serve` web UI.

## Requirements

R1. `catgo submit input.poscar` — submit using sane defaults (first
  available profile, code inferred from file extension fallback, queue
  from profile default, walltime 24 h, nodes 1).
R2. `--code {vasp,cp2k}` — explicit code choice.
R3. `--host <name>` — pick a specific profile by name (matches
  HPCProfile.name in `~/.catgo/hpc_profiles.json`).
R4. `--queue <q>` — SLURM partition.
R5. `--walltime <H>` — wall time in hours (int), translated to `HH:00:00`.
  Defaults to 24. Half-hour granularity not in P3.
R6. `--nodes <N>` — number of nodes.
R7. `--remote-dir <path>` — absolute remote work dir; default
  `~/catgo-jobs/<timestamp>-<jobname>`.
R8. `--job-name <name>` — SLURM job name; defaults to `catgo_<formula>`.
R9. `--no-autostart` global flag — N/A here (`submit` is not a viewer op),
  but does NOT error. We mark `needs_server=False`.
R10. Errors at every boundary (missing profile, bad code, ssh failure,
  sbatch nonzero exit) surface as `OpError` with a single-line message —
  no Python tracebacks at the CLI boundary.
R11. The handler returns `OpResult.artifact = local path to a directory
  containing the generated input deck`, so the user always has a local
  copy for the record.
R12. Tests cover the parser, the profile loader/validator, the deck
  generator (in-process adapter), the ssh/scp shell-out (with
  monkeypatched `subprocess.run`), and the end-to-end happy path through
  the registry.

## Architecture

```
catgo.cli.ops_submit          # handler
catgo.cli.hpc_link             # synchronous SSH/scp/sbatch driver
catgo.cli.ops.submit           # registry entry
catgo.cli._legacy / __init__   # untouched (registry-driven)
```

### `hpc_link.HpcLink` (new module)

```
HpcLink(profile: HPCProfile)        # constructor — validates auth_method
.preflight() -> str                  # returns remote $HOME (proves ssh works)
.mkdir_p(remote_dir)
.put_text(remote_path, content)      # one file
.put_bytes(remote_path, content)
.sbatch(remote_dir, script_name)     # cd && sbatch → job_id
```

All four methods shell out to system `ssh` / `scp` via
`subprocess.run(check=False, capture_output=True, timeout=…)`. For
`auth_method=ssh_config` we use the `ssh_alias`. For `auth_method=key`
we add `-i <key_file>` and `-o BatchMode=yes` so a missing key
fails fast instead of prompting. Hostnames are quoted with `shlex`.

Errors (nonzero exit, ssh stderr) raise `HpcError(msg, stderr)` which
the handler converts to an `OpError`.

### `ops_submit.submit(session, params) -> OpResult`

1. Resolve profile by `--host` (or first available) → validate auth_method.
2. Resolve code by `--code` (or `vasp` default) → load the matching FastAPI
   route via `adapter.call_route` and produce input strings.
3. Build a SLURM submit script (`catgo_submit.sh`) using a code-specific
   template (sources `~/.bashrc`, loads no modules — that's up to the
   user's `.bashrc`, since this is what the existing front-end submission
   does). Two embedded templates only — VASP and CP2K.
4. Resolve remote dir (`--remote-dir` or default
   `~/catgo-jobs/<UTC-ts>-<jobname>`).
5. ssh `mkdir -p`, scp each generated file + the submit script.
6. sbatch the script, parse `(\d+)` out of stdout for the job id.
7. Also write a local copy of every uploaded file to
   `./catgo-submit-<job_id>/` (relative to cwd). This is the
   `OpResult.artifact`.
8. Return success with message
   `submitted <code> <formula> job=<id> host=<profile.name> dir=<remote>`.

### Registry entry

```python
Operation(
    name="submit", group="hpc",
    summary="generate code input + scp + sbatch to remote HPC",
    params=[
        Param("code", str, default="vasp", choices=["vasp", "cp2k"], …),
        Param("host", str, default="", …),
        Param("queue", str, default="", …),
        Param("walltime", int, default=24, …),
        Param("nodes", int, default=1, …),
        Param("remote_dir", str, default="", …),
        Param("job_name", str, default="", …),
    ],
    handler=ops_submit.submit,
    needs_server=False,
    mutates=False,
)
```

The dash-form flag handling shipped in P3b C1 means the user sees
`--remote-dir` and `--job-name` in `--help` (with `--remote_dir` /
`--job_name` as compat aliases).

### Input-deck generators (in-process adapter)

```python
# VASP
from catgo.routers.vasp import generate_vasp_inputs_endpoint
from catgo.models.vasp import VASPInputRequest, VASPInputFiles, VASPCalculationType
result = call_route(generate_vasp_inputs_endpoint, VASPInputRequest,
                    structure=session.structure.as_dict(),
                    calculation_type=VASPCalculationType.OPT)
files = {"INCAR": result.incar, "POSCAR": result.poscar,
         "KPOINTS": result.kpoints}

# CP2K
from catgo.routers.cp2k import generate_input_file
from catgo.routers.cp2k import CP2KInputRequest  # request model lives in router
result = call_route(generate_input_file, CP2KInputRequest,
                    structure=session.structure.as_dict(),
                    run_type="GEO_OPT")
files = {f"{prefix}.inp": result.input_file}
```

`POTCAR` for VASP is NOT generated — VASP requires the user's licensed
pseudopotentials. We write a `POTCAR_NEEDED` marker file with the
element list and a comment "see `vaspkit` option 103 or upload manually";
the existing P3a "make-potcar" skill already covers this.

### SLURM script templates

Hardcoded in `ops_submit._slurm_script` because the existing
`hpc.py /submit` route takes the script as `script_content` — there's no
backend template generator. Two strings: one for VASP (`mpirun vasp_std`),
one for CP2K (`mpirun cp2k.psmp -i <prefix>.inp -o <prefix>.out`). The
"how do I actually run vasp on this cluster" question is left to the
user's `.bashrc` (login shell sourced).

Optional `queue` adds `#SBATCH -p <queue>`. Walltime hours → `HH:00:00`.

### Why not call `POST /hpc/submit`

The route depends on a pre-connected `HPCConnection` (loop-bound
asyncssh). Wiring that up just to write a script and call `sbatch` is
~200 lines of plumbing and a fragile test surface. The single `ssh`
invocation we shell out is functionally identical to the path
`SubprocessSSHRunner` already uses internally.

## Error handling

| Boundary | Failure mode | User message |
|---|---|---|
| `--host` not in profiles | KeyError | `host '<name>' not found in ~/.catgo/hpc_profiles.json (available: …)` |
| Profile has password auth | unsupported | `host '<name>': auth_method '<m>' needs interactive input; use ssh_config or key` |
| No profiles at all | empty list | `no HPC profiles; add one via 'catgo serve' web UI or ~/.catgo/hpc_profiles.json` |
| `--code` not vasp/cp2k | argparse `choices` | argparse default error |
| Session has no structure and no `<input>` | check | `submit requires <input> file or a loaded session structure` |
| Input file path missing | check | `submit input not found: <path>` |
| ssh exit ≠ 0 | HpcError | `ssh to <profile>: <stderr first line>` |
| scp exit ≠ 0 | HpcError | `scp <local> -> <profile>:<remote>: <stderr first line>` |
| sbatch exit ≠ 0 | HpcError | `sbatch on <profile>: <stderr first line>` |
| sbatch stdout has no job id | regex miss | `sbatch on <profile>: submitted but could not parse job id from '<stdout>'` |

`HpcError` is internal to `hpc_link.py`; the handler converts it to
`OpError` with a code/profile prefix.

## Tests

```
server/tests/cli/test_hpc_link.py    # subprocess.run monkeypatched
    test_ssh_config_runs_ssh_alias
    test_key_auth_adds_i_and_batchmode
    test_preflight_returns_home
    test_put_text_uses_scp
    test_sbatch_parses_job_id
    test_sbatch_nonzero_raises_hpcerror

server/tests/cli/test_ops_submit.py
    test_submit_vasp_happy_path           # _FakeHpcLink + monkeypatched call_route
    test_submit_cp2k_happy_path
    test_submit_unknown_host_errors
    test_submit_unsupported_auth_errors
    test_submit_no_structure_and_no_input_errors
    test_submit_writes_local_artifact_dir

server/tests/cli/test_argparse.py     # extend
    test_submit_subcommand_registered
    test_submit_dash_flag_aliases       # --remote-dir vs --remote_dir
```

Profile fixtures use an in-memory `HPCProfile(...)` list returned by
monkeypatching `catgo.utils.connection_pool.load_profiles`.

## Out of scope (deferred)

- Other codes (QE, ORCA, LAMMPS). Routers exist but not in P3.
- Password / OTP auth in the CLI.
- Job monitoring / log tail (separate P4 op).
- POTCAR auto-fetch (existing `make-potcar` skill covers it).
- Cancel / kill from CLI (existing route is session-coupled, deferred).
- `--dry-run` (consider for P4; would just print script and stop).

## Autonomous design decisions (for later review)

1. **Stdlib `subprocess` instead of in-process adapter to `hpc.py`** —
   avoids loop-bound asyncssh and the WebSocket interactive auth path.
   Pattern-matches P3a's choice of stdlib `urllib.request` over `httpx`.
2. **Only `ssh_config` and `key` auth supported** — both run headless;
   `password`/`*_otp` need stdin, which the CLI can't reasonably drive.
3. **Profile file is `~/.catgo/hpc_profiles.json`** — already exists, no
   new config schema. Validated by reusing `connection_pool.load_profiles`.
4. **SLURM script generated inline (template strings in ops_submit)** —
   the FastAPI `/hpc/submit` route also takes raw `script_content`; no
   shared template generator exists to reuse, and two short templates
   keep the test surface tight.
5. **VASP POTCAR not generated** — drop a `POTCAR_NEEDED` marker; users
   produce it locally with `vaspkit` (existing skill) or upload manually.
6. **Default code = vasp** when neither `--code` nor `<input>` suffix
   reveals the choice — VASP is the most common in this project's prior
   art (catgo-pull/catgo-load skills, P2 analyze ops).
7. **Walltime is integer hours, not `HH:MM:SS`** — matches the rest of
   the CLI's "single scalar per param" UX (the registry has no
   multi-field param type). Format conversion done in handler.
8. **Local copy goes to `./catgo-submit-<job_id>/`** — relative to cwd,
   not a tempdir; users want this around as a record.
9. **Both VASP `vasp_std` and CP2K `cp2k.psmp` assumed in PATH on remote
   via `bash -l`** — matches how `SubprocessSSHRunner` already invokes
   remote commands.
10. **`needs_server=False`** — `submit` does not touch the local CatGO
    viewer; auto-start would just confuse the user.
