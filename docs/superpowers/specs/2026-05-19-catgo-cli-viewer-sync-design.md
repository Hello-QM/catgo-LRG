# CatGO CLI — P3a Viewer Sync + Auto-Start Design Spec

Date: 2026-05-19
Status: Approved (brainstorming) — pending spec review
Stacks on: P2 analyze (`feature/catgo-cli-analyze`, PR catgo-dev#1). Branch
`feature/catgo-cli-viewer-sync`; independent PR base =
`feature/catgo-cli-analyze`. P3 was decomposed during brainstorming into
three slices — this is the first: **viewer sync + on-demand auto-start**.
The other two (HPC submission; minor cleanup including dash-flag UX, IR
spectra, multi-group PDOS, pylustrator subprocess isolation) follow.

## Goal

Add `catgo push` and `catgo pull` ops to the CLI so the operator can move
structures between the CLI's `Session` and the live CatGO viewer; when a
viewer-needing op is invoked and no server is reachable, the CLI
transparently spawns `catgo serve --daemon`, waits for `/health`, then
proceeds — implementing the parent-spec `needs_server` + auto-start
contract that was deferred to P3.

## Requirements (confirmed)

- Two new top-level ops: `push` (file or session structure → viewer) and
  `pull` (viewer panel → session structure, optionally → file).
- Port detection: probe `:8000` first, fall back to `:33413` (matches the
  `catgo-load`/`catgo-pull` skill convention so users with a reverse tunnel
  from a laptop work without extra flags).
- Auto-start: if a `needs_server` op runs with `Session.link is None`,
  spawn `catgo serve --daemon`, poll `/health` with backoff (≤20 s), then
  build a `ServerLink`; spawn-failure → clean `OpError`, no hang.
- `--no-autostart` global flag opts out (scripted / strict-offline use).
- `pull` updates `session.structure` (so chains like
  `pull → supercell → push` work) AND writes to `-o` if given.
- `--panel <id>` opt-in; omitted → server uses the current/default panel.
- All scientific params live-tunable (per project convention; no
  hardcoded ports — discovered base URL is reused for all calls).

## Approach

**A — full parent-spec implementation, stdlib HTTP** (chosen over
skip-auto-start and over `curl` subprocess). `ServerLink` wraps
`urllib.request` (no new dependency), exposes `discover()` /
`push_structure(path, panel_id)` / `pull_structure(format, panel_id)`.
Auto-start uses `subprocess.Popen([sys.executable, "-m", "catgo", "serve",
"--daemon"])` (reuses the P1 `catgo serve --daemon` command) plus a
backoff poll on `/health`. Tests monkeypatch `urlopen` /
`subprocess.Popen` so CI never needs a real server.

## §1 Architecture & port detection + ServerLink

Stack: branch `feature/catgo-cli-viewer-sync` from `feature/catgo-cli-analyze`
HEAD `33baad6d`. Independent PR base = `feature/catgo-cli-analyze`. Reuse
P1/P2 registry/Session/dual-form skeleton; add only viewer ops + the
ServerLink/autostart infrastructure.

### `ServerLink` (new file `server/catgo/cli/server_link.py`)

```python
@dataclass
class ServerLink:
    base_url: str                   # "http://localhost:8000" or :33413

    @classmethod
    def discover(cls) -> "ServerLink | None":
        """Probe :8000 → :33413 (catgo-load skill convention)."""
        for port in (8000, 33413):
            if _ping(f"http://localhost:{port}/health"):
                return cls(base_url=f"http://localhost:{port}")
        return None

    def push_structure(self, path: Path, panel_id: str | None) -> dict:
        """POST /api/view/upload-and-load (multipart). Returns the
        server's JSON response (panel_id, num_sites, …)."""

    def pull_structure(self, fmt: str, panel_id: str | None) -> bytes:
        """GET /api/view/structure/export?format=<fmt>[&panel_id=<id>].
        Returns the raw structure-file bytes."""
```

Implementation notes:
- `_ping` uses `urllib.request.urlopen(url, timeout=0.5)`; treats any 2xx
  as alive, any exception as dead.
- Multipart POST built manually (stdlib has no easy form-encoder); the
  field name is `file` per `view_capture.upload_h5`'s `UploadFile`.
- 4xx/5xx → raise `OpError` with the server's JSON `detail` if present
  else the HTTP status text; network errors → `OpError` with cause.
- No new dependency (urllib is stdlib).

### `Session.link` ← `ServerLink | None`

P1/P2 already declares the placeholder field `link: object | None = None`
(`session.py`). Tighten the annotation to `ServerLink | None`; populated
at CLI entry (in `__init__.main` before dispatch) by
`Session.link = ServerLink.discover()`.

### Auto-start (`server/catgo/cli/_autostart.py`)

```python
def spawn_daemon_and_wait(timeout: float = 20.0) -> ServerLink:
    """Spawn `catgo serve --daemon` and poll /health until reachable.

    Raises OpError on spawn failure, port-already-in-use without
    /health response, or timeout.
    """
```

- `subprocess.Popen([sys.executable, "-m", "catgo", "serve", "--daemon"],
   stdout=DEVNULL, stderr=PIPE, start_new_session=True)`
  (`start_new_session` detaches so the daemon outlives the CLI).
- Poll with exponential backoff (0.2, 0.4, 0.8, 1.6, … capped at 2.0 s),
  total ≤ `timeout` seconds.
- On success: call `ServerLink.discover()` (which itself probes
  :8000→:33413) and return; auto-started backend listens on :8000.
- On timeout: capture the spawn's stderr tail for the OpError message;
  do NOT kill the spawned process (port may already be in use by another
  service — leave the user's environment unchanged).

### `_run_op` / shell hook

Both the argparse path (`__init__._run_op`) and the interactive shell
(`shell.run`) add a single pre-handler check:

```python
if op.needs_server and session.link is None:
    if args_no_autostart:                 # --no-autostart was set
        raise OpError("--no-autostart: server unreachable")
    session.link = spawn_daemon_and_wait()
```

`--no-autostart` is a new GLOBAL flag added to the top-level argparse
parser (NOT per-op) so any subcommand can opt out: `catgo --no-autostart
push x.vasp` and `catgo --no-autostart` (interactive shell, then any
needs_server op refuses cleanly).

### File structure

- `server/catgo/cli/server_link.py` — `ServerLink` class.
- `server/catgo/cli/_autostart.py` — `spawn_daemon_and_wait`.
- `server/catgo/cli/ops_viewer.py` — `push`/`pull` handlers.
- `server/catgo/cli/ops.py` (P1) — append 2 `registry.add(...)`, `group="viewer"`.
- `server/catgo/cli/__init__.py` — discover on entry; `--no-autostart`
  global flag; pre-handler needs_server hook.
- `server/catgo/cli/shell.py` — discover on entry; same pre-handler hook.
- `server/catgo/cli/session.py` — tighten `link` annotation (no behavior
  change; field already exists).
- Tests: `server/tests/cli/test_server_link.py`, `test_autostart.py`,
  `test_ops_viewer.py`, plus an appended dual-form check in
  `test_equivalence.py` and an `--no-autostart` test in `test_argparse.py`.

## §2 `push` / `pull` op schemas

### `push` (`needs_server=True`, `mutates=False`)

CLI: `catgo push [input] [--panel <id>]`
Menu prompts: `input path (empty=use session structure):` then `panel id (empty=default):`.

Resolution:
1. If `input` given → use that file path verbatim.
2. Else if `session.structure` set → `session.save(<tmpfile>.vasp)` (P1
   helper handles `.vasp` → POSCAR fmt pin) → use that path; delete temp
   in a `finally`.
3. Else → `OpError("push requires <input> file or a loaded session "
   "structure")`.

Call: `link.push_structure(path, panel_id)` → returns JSON
`{"panel_id": ..., "num_sites": ..., ...}` (server response shape from
`view_capture.upload_and_load`).

Success message: `pushed <formula> (N sites) -> viewer panel=<panel_id>`.

### `pull` (`needs_server=True`, `mutates=True`)

CLI: `catgo pull [--panel <id>] [--format poscar|cif|xyz] [-o <path>]`
Menu prompts: `panel id (empty=current):`, `format [poscar]:`, `out path (empty=session only):`.

Resolution:
1. `data = link.pull_structure(fmt, panel_id)` → bytes (server returns
   structure-file content as the response body, see
   `view_capture.structure_export`).
2. Write to temp file with `.{fmt}` extension; call `session.load(tmp)`
   (P1 `read_structure` handles all P1/P2 formats via pymatgen +
   AseAtomsAdaptor); `os.unlink(tmp)`.
3. If `-o` given → `session.save(out)`.
4. `mutates=True` → P1 dispatch auto-snapshots `session.structure`
   before this op for undo.

Success message: `pulled <formula> (N sites) <- viewer panel=<panel_id>`
(append ` -> <out>` if `-o`).

`session.structure` is updated unconditionally (per user requirement
"两者都"). `OpResult.structure` is set so menu users see the new state
on the next banner refresh.

### Registry

```python
reg.add(Operation(
    name="push", group="viewer",
    summary="upload structure to the CatGO viewer (auto-starts server)",
    params=[
        Param("panel", str, default="", help="viewer panel id (empty=current)"),
    ],
    handler=ops_viewer.push, needs_server=True, mutates=False))

reg.add(Operation(
    name="pull", group="viewer",
    summary="download current viewer structure into the session",
    params=[
        Param("panel", str, default="", help="viewer panel id (empty=current)"),
        Param("format", str, default="poscar",
              choices=["poscar", "cif", "xyz", "extxyz"]),
    ],
    handler=ops_viewer.pull, needs_server=True, mutates=True))
```

`panel` defaults to empty-string (server picks the current panel); the
handler converts `""` → `None` (omit the query parameter). `format`
choices propagate to argparse via the P2 dual-form fix.

## §3 Error handling / testing

### Error table (extends P1/P2)

| Scenario | Behavior |
|---|---|
| `:8000` AND `:33413` both unreachable on startup | `session.link = None`; offline ops proceed; `needs_server` ops trigger auto-start |
| auto-start spawn failure (Popen exception) | `OpError("backend spawn failed: <cause>")` exit 2 |
| auto-start poll timeout (≤20 s, /health never returns) | `OpError("backend failed to start within 20 s; try `catgo serve` manually")` + spawn-stderr tail; **do NOT kill** the spawned process |
| `--no-autostart` + `needs_server` op + `link=None` | `OpError("--no-autostart: server unreachable; start `catgo serve` first")` exit 2 |
| `push` with no `input` AND `session.structure is None` | `OpError("push requires <input> file or a loaded session structure")` |
| HTTP 4xx/5xx from `push`/`pull` | `OpError("server error: <detail>")` extracted from response JSON or status text |
| Network reset mid-call | `OpError("server connection dropped: <reason>")`; session unchanged |
| viewer panel empty / non-existent (server 4xx) | `OpError("viewer panel '<id>' is empty or absent")` |
| `pull` then session.save fails | P1 `SessionError` boundary already handles |

No raw tracebacks at any boundary (P1/P2 contract preserved).

### Tests (TDD, pytest, `server/tests/cli/`)

1. **`test_server_link.py`** — `ServerLink.discover` monkeypatches `_ping`
   to simulate `:8000` ok / `:8000` fail + `:33413` ok / both fail; assert
   `base_url` and `None` outcomes. `push_structure`/`pull_structure`
   monkeypatch `urlopen` to verify URL, HTTP method, multipart body
   contains the file, `panel_id` query param presence/omission, JSON
   response parsing, 4xx → OpError with detail extracted.

2. **`test_autostart.py`** — monkeypatch `subprocess.Popen` to return a
   fake process (no real spawn); monkeypatch `_ping` to fail N times then
   succeed; assert Popen invoked with
   `[sys.executable, "-m", "catgo", "serve", "--daemon"]` +
   `start_new_session=True`; assert backoff respects the cap; timeout path
   raises OpError with stderr tail in message.

3. **`test_ops_viewer.py`** — `push` with no input + session.structure
   set → temp `.vasp` written, ServerLink.push_structure called with that
   path, temp cleaned up even on failure (`finally`); `push` with neither
   → OpError. `pull` writes server bytes to temp, calls session.load,
   updates session.structure, deletes temp; `-o` given → also session.save.
   Both ops with `panel=""` → handler passes `None` for panel_id.

4. **`test_argparse.py`** (append) — `_run_catgo("--no-autostart",
   "push", "<file>")` returns exit 2 with `"--no-autostart"` and
   `"unreachable"` in stderr (no traceback). `_run_catgo("push", "--help")`
   shows `--panel`. `_run_catgo("pull", "--help")` shows
   `--panel`, `--format {poscar,cif,xyz,extxyz}`.

5. **`test_equivalence.py`** (append) — `build_registry()` exposes `push`
   and `pull` with `group="viewer"`, `needs_server=True`,
   `push.mutates=False`, `pull.mutates=True`.

6. **Auto-start hook integration** — `__init__._run_op` with a
   mock-discover returning None first, then monkeypatched
   `spawn_daemon_and_wait` returning a fake ServerLink; assert hook fires,
   session.link is set, original op proceeds; `--no-autostart` path
   asserts hook is NOT invoked and OpError raised cleanly.

7. **Regression** — P1/P2 offline ops (`slab`, `inspect`, `freq --no_anim`)
   never trigger auto-start, never call ServerLink methods (monkeypatched
   `ServerLink.discover` to fail; assert offline ops still pass). Guards
   the contract that only `needs_server=True` ops touch the server.

CI never starts a real daemon; all tests monkeypatch the network and
subprocess boundaries.

## Out of scope (later P3 slices)

- HPC submission (next slice).
- IR spectra / non-imaginary mode plotting (cleanup slice).
- Dash-style flag names (`--no-anim` → `--no-anim`) (cleanup slice).
- pylustrator subprocess isolation for long-lived shells (cleanup slice).
- `compute_pdos_groups` multi-group surface (cleanup slice).
- Pushing animation trajectories (multi-frame) to the viewer — `push` ships
  for a single Structure; multi-frame trajectory push is deferred.
