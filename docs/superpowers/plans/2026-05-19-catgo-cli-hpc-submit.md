# Plan: catgo submit (Slice D)

Spec: `docs/superpowers/specs/2026-05-19-catgo-cli-hpc-submit-design.md`.
Branch: `feature/catgo-cli-hpc-submit` (base = `feature/catgo-cli-cleanup`).

Each task = failing test → impl → green → commit. No placeholders.

## Task D1 — `HpcLink.__init__` + auth validation

Test: `test_hpc_link.py::test_init_rejects_password_auth` — building
`HpcLink(HPCProfile(auth_method=AuthMethod.PASSWORD, …))` raises
`HpcError("auth_method 'password' needs interactive input; use "
"ssh_config or key")`.
Test: `test_init_accepts_ssh_config_and_key`.

Impl: create `server/catgo/cli/hpc_link.py` with:

```python
class HpcError(Exception): ...
@dataclass
class HpcLink:
    profile: HPCProfile
    timeout: int = 60
    def __post_init__(self):
        if self.profile.auth_method not in (AuthMethod.SSH_CONFIG, AuthMethod.KEY):
            raise HpcError(...)
```

Commit: `feat(cli): HpcLink scaffold + auth validation`

## Task D2 — `HpcLink._ssh_argv` / `_scp_argv` helpers

Test: `test_ssh_argv_for_ssh_config` — `HpcLink(profile=ssh_config_profile)._ssh_argv("ls")`
returns `["ssh", "-o", "BatchMode=yes", "<alias>", "bash -l -c 'ls'"]`.
Test: `test_ssh_argv_for_key_auth` — `KEY` profile yields
`["ssh", "-i", "<key>", "-o", "BatchMode=yes", "-p", "22",
"<user>@<host>", "bash -l -c 'ls'"]`.
Test: `test_scp_argv_for_ssh_config` — returns
`["scp", "-o", "BatchMode=yes", "<local>", "<alias>:<remote>"]`.
Test: `test_scp_argv_for_key_auth` — adds `-i <key>` and `-P <port>`
(note: scp uses `-P` for port, unlike ssh `-p`).

Impl: `_ssh_argv(remote_cmd)`, `_scp_argv(local_path, remote_path)`.

Commit: `feat(cli): HpcLink ssh/scp argv builders`

## Task D3 — `HpcLink.preflight` + `mkdir_p`

Test: `test_preflight_returns_home` — monkeypatch `subprocess.run` to
return a CompletedProcess with `stdout="/home/u\n"`; `preflight()` →
`"/home/u"`. Asserts the argv contains `echo $HOME`.
Test: `test_preflight_nonzero_raises_hpcerror` — `returncode=1`,
`stderr="Permission denied"` → `HpcError("ssh to <name>: Permission denied")`.
Test: `test_mkdir_p_uses_ssh_mkdir_minus_p`.

Impl: `_run(argv)` helper that wraps `subprocess.run(check=False,
capture_output=True, text=True, timeout=self.timeout)`, returns
`(rc, stdout, stderr)`, raises `HpcError` on rc != 0 or timeout
(`subprocess.TimeoutExpired` → `HpcError(... "timed out")`).
`preflight()` runs `echo $HOME`. `mkdir_p(path)` runs
`mkdir -p <shlex-quoted-path>`.

Commit: `feat(cli): HpcLink preflight + mkdir_p`

## Task D4 — `HpcLink.put_text` (scp via tempfile)

Test: `test_put_text_writes_temp_then_scp` — monkeypatched
`subprocess.run` records argv list; asserts last call is a scp from a
local tempfile to the right `<dest>:<remote>`. After the call, the local
temp is unlinked.
Test: `test_put_text_scp_failure_raises_hpcerror`.

Impl: write content to a `NamedTemporaryFile(delete=False)`, call
`_run(self._scp_argv(tmp, remote_path))`, `finally: tmp.unlink()`.

Commit: `feat(cli): HpcLink put_text via scp`

## Task D5 — `HpcLink.sbatch` (returns job id)

Test: `test_sbatch_parses_job_id` — stdout `Submitted batch job 12345`,
job_id="12345". argv contains `cd <dir> && sbatch <script>`.
Test: `test_sbatch_no_job_id_raises_hpcerror` — stdout
`"weird success"` → `HpcError(... "could not parse job id")`.
Test: `test_sbatch_nonzero_raises_hpcerror`.

Impl: `sbatch(remote_dir, script_name)` runs
`cd <q-dir> && sbatch <q-script>` via ssh, regex `(\d+)` (last match in
stdout), returns the string. (Mirrors `hpc.py:resubmit_job_endpoint`.)

Commit: `feat(cli): HpcLink sbatch + job-id parse`

## Task D6 — `ops_submit._slurm_script` (templates)

Test: `test_slurm_script_vasp_minimal` — assert lines start with `#!/bin/bash`,
include `#SBATCH --job-name=<name>`, `#SBATCH --nodes=<n>`,
`#SBATCH --time=<HH>:00:00`, and a `mpirun vasp_std > vasp.log` line.
Test: `test_slurm_script_vasp_with_queue` — `--queue gpu` adds
`#SBATCH -p gpu`.
Test: `test_slurm_script_cp2k_uses_psmp_and_prefix` — body has
`mpirun cp2k.psmp -i <prefix>.inp -o <prefix>.out`.

Impl: create `server/catgo/cli/ops_submit.py` with private
`_slurm_script(code, job_name, nodes, walltime_h, queue, prefix)` ->
str. Two branches.

Commit: `feat(cli): SLURM script templates for VASP/CP2K submit`

## Task D7 — `ops_submit._generate_vasp_deck` / `_generate_cp2k_deck`

Test: `test_generate_vasp_deck_returns_three_strings` — call against
session containing a 2-atom Cu structure; assert returned dict has keys
`INCAR`, `POSCAR`, `KPOINTS` all non-empty + `POTCAR_NEEDED` marker
file content lists `Cu`.
Test: `test_generate_cp2k_deck_returns_inp_with_prefix` — returned dict
has `{prefix}.inp` and content contains `&FORCE_EVAL`.

Impl: thin wrappers around `adapter.call_route` for the two FastAPI
endpoints. Returns a `dict[str, str]` of `relpath -> content`.

Commit: `feat(cli): VASP/CP2K input-deck generators (in-process adapter)`

## Task D8 — `ops_submit.submit` happy path (no-host = first profile)

Test: `test_submit_vasp_happy_path` — Session with Cu structure;
`monkeypatch.setattr("catgo.cli.ops_submit.load_profiles", lambda: [ssh_config_profile])`;
fake `HpcLink` class via `monkeypatch.setattr("catgo.cli.ops_submit.HpcLink", _FakeLink)`;
`_FakeLink` records every method call; `submit(s, {"code":"vasp", ...})` →
ok, message contains `submitted vasp Cu job=99 host=lab`. `_FakeLink`
should record `mkdir_p`, ≥3 `put_text` calls (INCAR/POSCAR/KPOINTS),
+ `put_text` for the submit script, + `sbatch`. Local artifact dir
`catgo-submit-99/` exists in tmp_path/cwd and has all four files.
Test: `test_submit_cp2k_happy_path` — analogous; one inp file +
script.

Impl: `submit(session, params) -> OpResult` per spec:

1. Resolve profile (`--host` or first matching available; raise OpError
   on miss).
2. Resolve input structure: `<input>` param overrides session.
3. Resolve remote_dir (`--remote-dir` or default
   `~/catgo-jobs/{utc-ts}-{job_name}`).
4. Generate deck via `_generate_*_deck`.
5. Build SLURM script via `_slurm_script`.
6. `link = HpcLink(profile)`; `link.preflight()`; `link.mkdir_p(remote_dir)`.
7. For each `(name, content)` in deck + the script: `link.put_text`.
8. `job_id = link.sbatch(remote_dir, "catgo_submit.sh")`.
9. Write local copy under `Path("catgo-submit-" + job_id)`.
10. Return `OpResult(ok=True, message=…, artifact=local_dir,
    structure=None)`.

Commit: `feat(cli): submit handler — generate deck + scp + sbatch`

## Task D9 — submit error surfaces

Test: `test_submit_unknown_host_errors` —
`load_profiles=lambda:[ssh_config_profile]`, `--host nosuch` →
`OpError("host 'nosuch' not found in ~/.catgo/hpc_profiles.json (available: lab)")`.
Test: `test_submit_no_profiles_errors` — `load_profiles=lambda:[]` →
`OpError("no HPC profiles; …")`.
Test: `test_submit_unsupported_auth_errors` — profile with
`auth_method=PASSWORD` and `--host name`. → OpError with `auth_method`.
Test: `test_submit_no_structure_and_no_input_errors` — empty session,
no input → `OpError("submit requires <input> file or a loaded session structure")`.
Test: `test_submit_input_file_missing_errors`.

Impl: precondition guards in `submit` before any network call.

Commit: `feat(cli): submit precondition guards (host/auth/input)`

## Task D10 — Registry + argparse wiring

Test: `test_argparse.py::test_submit_subcommand_registered` —
`parser.parse_args(["submit", "in.vasp", "--code", "vasp",
"--host", "lab", "--walltime", "12", "--nodes", "2"])` parses
without error and the resulting `args._op.name == "submit"`.
Test: `test_submit_dash_flag_aliases` — `--remote-dir /tmp` parses
the same as `--remote_dir /tmp` (P3b C1 mechanism, exercised once).

Impl: in `ops.py`, import `ops_submit`, register the op:

```python
from catgo.cli import ops_submit
reg.add(Operation(
    name="submit", group="hpc",
    summary="generate code input + scp + sbatch to remote HPC",
    params=[
        Param("code", str, default="vasp", choices=["vasp","cp2k"],
              help="code: vasp|cp2k"),
        Param("host", str, default="",
              help="HPC profile name (~/.catgo/hpc_profiles.json)"),
        Param("queue", str, default="",
              help="SLURM partition (empty = scheduler default)"),
        Param("walltime", int, default=24, help="wall time (hours)"),
        Param("nodes", int, default=1, help="number of nodes"),
        Param("remote_dir", str, default="",
              help="remote work dir (empty = ~/catgo-jobs/<ts>-<name>)"),
        Param("job_name", str, default="",
              help="SLURM job name (empty = catgo_<formula>)"),
    ],
    handler=ops_submit.submit, needs_server=False, mutates=False))
```

Commit: `feat(cli): register submit op (hpc group, dash-form flags)`

## Task D11 — Equivalence + shell smoke (registry-driven path covered)

Test: `test_equivalence.py::test_submit_shell_and_argv_match_handler`
— in the shell, given the right `input_fn` stubs the same params reach
`ops_submit.submit` with the same dict shape as the argparse path.
Use the same `_FakeLink` + `_fake_load_profiles` strategy.

Impl: confirm the existing shell loop already prompts for `op.params`
in order — no code change unless something genuinely missing. The
analyze-group pre-prompt for `input` already runs only on `group=="analyze"`;
hpc group does not need a pre-prompt because the structure comes from
the session (`<input>` is optional, like push).

Wait — for `submit` we DO want the user to be able to pass `<input>`.
The argparse path already has `p.add_argument("input", nargs="?")` for
every op. The handler will check session OR `params.get("input")`. The
shell path: for non-analyze ops the shell does not prompt for input, it
relies on a previously loaded session structure (via menu choice 0).
That's fine — that's the established UX.

Commit: `test(cli): shell+argv equivalence for submit op`

## Task D12 — README-level docstring + final suite green

No new test. Just run `python -m pytest tests/cli/ -q` and ensure
108→117 passed, 3 skipped.

Commit: `chore(cli): submit op docstring + final suite green`

## Order of work

D1 → D2 → D3 → D4 → D5 → D6 → D7 → D8 → D9 → D10 → D11 → D12.

Each commit standalone (compiles + tests pass).

## Open items deferred to follow-up

- POTCAR auto-generation. The skill `make-potcar` exists; integrating
  is its own slice.
- `--watch` to poll squeue post-submission.
- More codes (QE, ORCA). Routers exist.
