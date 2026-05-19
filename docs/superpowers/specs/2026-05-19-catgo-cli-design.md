# CatGO Interactive CLI — Design Spec

Date: 2026-05-19
Status: Approved (brainstorming) — pending spec review

## Goal

Give CatGO a vaspkit/multiwfn-style CLI: a stateful interactive menu **and**
scriptable subcommands, sharing one source of truth, usable offline (no server)
with optional viewer sync when a server is running.

## Requirements (confirmed)

- **Dual form factor**: no-arg → interactive menu; with-args → scriptable subcommands.
- **Hybrid backend**: default in-process `import` (offline, HPC-scriptable); auto-upgrade
  to HTTP when `localhost:8000` reachable (viewer push/pull only in this mode).
- **MVP scope (all 4 groups)**: structure build, format convert/inspect, analysis
  post-processing, viewer-sync + HPC. Delivered phased (see Phasing).
- **Stateful session + viewer sync**: one active structure persists across menu
  operations (slab → adsorbate → convert → export); undo supported.

## Approach

**Operation Registry + shared handlers** (chosen over thin-HTTP-only and
MCP-wrapper alternatives). Each capability is a pure handler
`(session, params) -> OpResult` registered once; both the argparse subcommand
tree and the interactive menu consume the same registry — zero logic fork.

### Backend access (key decision)

Business logic currently lives inside FastAPI route handlers (async + Pydantic
request models) in `server/catgo/routers/` (structure_ops.py, build.py, dos.py,
…). Two paths for import-mode:

- **(a) Adapter direct-call (chosen for P1)**: CLI builds the request model →
  `asyncio.run(route_fn(ReqModel(**params)))` → unwrap `StructureResult`. Zero
  refactor; cost = CLI coupled to route signatures (covered by adapter tests).
- **(b) Extract `catgo/core/` pure layer** that both routers and CLI call.
  Clean but touches many router files. Deferred — opportunistic extraction of
  hot ops in P2/P3, not a big-bang refactor.

`ServerLink`: on startup ping `localhost:8000/health`. Reachable → HTTP mode
available (viewer push/pull). Unreachable → pure import mode for offline ops.

**Auto-start on demand**: when a `needs_server` op (viewer push/pull, anything
that visualizes the structure) is invoked while no server is reachable, the CLI
does **not** grey out or abort — it auto-launches the backend:

1. spawn `catgo serve --daemon` (reuse existing serve subcommand) as a detached
   background process
2. poll `localhost:8000/health` until ready (timeout ~20s, backoff)
3. build `ServerLink`, then proceed with the originally requested op transparently
4. spawn fails (port taken, backend error) → only then error out with diagnostics

The auto-started server is left running after the CLI exits (viewer needs it
alive); CLI does not own its lifecycle / does not stop it on quit. If a server
is already reachable, no spawn — reuse it. `--no-autostart` disables this
(revert to grey-out/abort behavior) for scripted/offline-strict use.

## Architecture

```
catgo.cli:main  (entry already exists: [project.scripts] catgo = "catgo.cli:main")
  ├─ no argv → InteractiveShell(session)        ← stateful menu
  └─ argv    → argparse subcommand tree → op handler   ← scriptable
        (keeps existing serve/setup/status/stop subcommands)
                    │
              OperationRegistry  ← single source of truth
                    │  each: name, group, params schema, handler, needs_server, mutates
                    ▼
              Session  ← holds active Structure + optional ServerLink
                    │
        ┌───────────┴───────────┐
   import mode               HTTP mode (server reachable)
   in-process adapter        httpx → localhost:8000
   asyncio.run(route_fn(     /api/structure-ops/*, /api/view/*
     ReqModel(**params)))    (viewer sync only here)
```

## Components

### Session (`server/catgo/cli/session.py`)

```python
@dataclass
class Session:
    structure: Structure | None = None      # pymatgen Structure, active
    source_path: Path | None = None         # load origin, for default out name
    history: list[Structure] = field(default_factory=list)  # undo stack
    link: ServerLink | None = None          # non-None only if :8000 reachable

    # ASE-only formats (.extxyz/.mol2/.pdb) read/written via
    # pymatgen.io.ase.AseAtomsAdaptor so session.structure is ALWAYS a
    # genuine pymatgen.core.Structure (NOT catgo.utils.converter, whose
    # ase_to_pymatgen returns a different pydantic model type and whose
    # pymatgen_to_ase has a pre-existing crash on plain-element structures).
    # P1 known limit: AseAtomsAdaptor.get_structure needs a periodic cell;
    # non-periodic .mol2/.pdb molecules are a P2 concern (P1 build ops
    # already require periodic input anyway).
    def load(self, path) -> None            # file → structure (type-faithful)
    def push_history(self) -> None          # snapshot before mutating op
    def undo(self) -> None
    def save(self, path, fmt=None) -> None
    def push_viewer(self) -> None           # requires link else NoServerError
    def pull_viewer(self) -> None
```

One active `structure`; mutating ops chain on it; `history` stack powers `u` undo.

### OperationRegistry (`server/catgo/cli/registry.py`)

```python
@dataclass
class Param:
    name: str; type: type; required: bool = True
    default: Any = None; help: str = ""; choices: list | None = None

@dataclass
class Operation:
    name: str                    # "slab", "supercell", "convert"
    group: str                   # "build" | "convert" | "analyze" | "viewer"
    summary: str
    params: list[Param]
    handler: Callable[[Session, dict], OpResult]
    needs_server: bool = False   # True → greyed in import mode
    mutates: bool = True         # True → push_history() before handler

@dataclass
class OpResult:
    ok: bool; message: str
    structure: Structure | None = None   # non-null → write back to session
    artifact: Path | None = None         # written file (convert/analysis plot)
```

Registration example:

```python
registry.add(Operation(
    name="slab", group="build", summary="bulk → surface slab",
    params=[
        Param("miller", tuple, help="e.g. 1,1,0"),
        Param("layers", int, default=4),
        Param("vacuum", float, default=15.0),
    ],
    handler=ops_build.slab,   # adapter: SlabRequest → asyncio.run(generate_slab(req))
))
```

Both form factors consume the same registry: argparse iterates → one subparser
per Operation, Param → add_argument; menu lists by group, prompts params with
defaults. New capability = one `registry.add(...)`; both forms get it.

### InteractiveShell (`server/catgo/cli/shell.py`)

```
══ CatGO CLI ══  [structure: Pt(111) 64 atoms ← slab.vasp]  [server: ✓ :8000]

  0)  Load structure (file / from viewer)
 ── build ──────────────
  1)  Slab from bulk        2) Supercell        3) Place adsorbate
  4)  Heterostructure       5) Nanotube / moiré
 ── convert & inspect ──
  6)  Convert format        7) Composition / symmetry / bond lengths
 ── analyze ────────────
  8)  DOS / band / COHP / freq   (reads OUTCAR/vasprun…)
 ── viewer & HPC ───────
  9)  Push to viewer [server ✓]  10) Pull from viewer [server ✓]
 11)  Gen VASP/CP2K input + submit SLURM

  s) Save   u) Undo   p) Print state   q) Quit
```

- Top bar = live `Session` state; refreshed after each action.
- Number → prompt that op's params (show default, Enter = take default; list `choices`).
- `mutates=True` → auto `push_history()` before handler; `u` reverts.
- `needs_server` w/o link: selecting auto-starts backend (spawn `catgo serve
  --daemon`, wait `/health`, then run op); shows "starting server…" progress;
  only spawn failure errors. `--no-autostart` → revert to grey-out + hint.
- `OpResult.structure` non-null → written back to `session.structure`.

### Subcommand mapping (auto-generated from same registry)

```
catgo slab        in.vasp --miller 1,1,0 --layers 4 --vacuum 15 -o slab.vasp
catgo supercell   in.vasp --nx 2 --ny 2 --nz 1 -o sc.vasp
catgo adsorbate   slab.vasp --mol CO --site ontop --height 1.8 -o ads.vasp
catgo convert     in.cif -o out.xyz
catgo inspect     POSCAR                      # composition/symmetry/bonds → stdout
catgo analyze dos vasprun.xml --out dos.png
catgo push        slab.vasp                   # needs server
catgo pull        -o current.vasp             # needs server
```

Conventions:
- positional 1 = input structure path (omitted → session/stdin; required in scripts)
- `-o/--out` default derived from `source_path` + op name (`POSCAR` → `POSCAR.slab.vasp`)
- `--remote` forces HTTP mode; `--quiet` error-code only; exit codes 0 / non-0
- `catgo --list` lists all ops; `catgo <op> -h` auto-generated from Params

## Error handling

| Scenario | Behavior |
|---|---|
| File missing / unparseable | menu: red error, return main, session unchanged; CLI: stderr + exit 1 |
| `needs_server` w/o link | auto-start backend (spawn `catgo serve --daemon`, poll `/health`, proceed); only spawn failure → `error: backend failed to start` exit 2. `--no-autostart` → menu greyed + hint / CLI exit 2 immediately |
| auto-start timeout / port taken | error with cause + manual `catgo serve` hint; session unchanged |
| handler raises (pymatgen etc.) | caught → `OpResult(ok=False, message=str(e))`; session not written back (history already snapshotted); menu no crash, CLI exit 1 |
| server drops mid-op (HTTP) | httpx timeout caught → degrade hint; not silently swallowed |
| output path exists | menu: ask overwrite y/N; CLI: refuse unless `--force` |
| viewer empty (pull) | explicit "viewer empty" error, no null deref |

Principle: handlers never `sys.exit`/`print`; return `OpResult` only. Exit codes
and terminal output translated uniformly by the shell/argparse layer → both form
factors behave identically.

## Testing (TDD, pytest, `server/tests/cli/`)

1. **registry**: every Operation params schema valid, handler callable, `--list` complete
2. **handler unit** (core): import-mode pure-functional, Structure in → assert Structure/artifact out, no server; one set per op (slab layers/vacuum, supercell multiples, convert round-trip, inspect numerics)
3. **dual-form equivalence**: same op+params via argparse path vs menu path → same OpResult (guards logic fork)
4. **server mode + auto-start**: mock httpx / test server, assert push/pull hit correct endpoints; auto-start path — no server → invoke needs_server op → asserts spawn called, polls health, op proceeds; `--no-autostart` → asserts no spawn + exit 2; spawn-failure → exit 2 + session unchanged
5. **error injection**: bad file, missing server, handler raises → exit code + session unchanged
6. **adapter**: `asyncio.run(route_fn(ReqModel))` unwraps `StructureResult` correctly (guards route-signature drift)

CI: pure-import tests have no server dependency; runnable standalone (matches HPC offline scenario).

## Phasing

- **P1**: registry + Session + dual-form skeleton + adapter pattern; groups
  **build** + **convert/inspect** (import-only). No viewer/HPC yet.
- **P2**: **analyze** group (DOS/band/COHP/freq read+plot).
- **P3**: **viewer sync** (push/pull, HTTP mode) + **on-demand backend
  auto-start** (`--no-autostart` opt-out) + **HPC** (gen input + SLURM submit).

Each phase: spec slice → plan → implement → tests green before next.

## Out of scope (YAGNI)

- Config-file profiles, shell completion, TUI/curses framework (plain prompts only).
- Rewriting routers into a core layer wholesale (opportunistic only).
- Windows-specific packaging (entry point already cross-platform via pyproject).
