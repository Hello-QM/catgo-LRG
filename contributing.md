# CatGo Contributing Guide

Thanks for contributing to CatGo. This guide covers the development setup,
the documentation layout, and a few tips for working with AI coding
assistants (Claude Code / Cursor / Copilot) on top of the codebase.

---

## 1. Development Setup

```bash
# 1. Clone the project
git clone https://github.com/Hello-QM/catgo-LRG.git
cd catgo-LRG

# 2. Install JS / pnpm dependencies
pnpm install

# 3. Run the desktop frontend + Python backend together
pnpm desktop:serve            # vite on :3100, FastAPI on :8000

# 4. Or run the Tauri native shell (production frontend + native window)
pnpm tauri:dev                # builds vite then opens the Tauri window

# 5. Backend-only (if you're only working on Python tooling / MCP)
cd server
pip install -r requirements.txt
python main.py                # http://localhost:8000
```

If you need a fresh checkout to behave like CI, also run:

```bash
pnpm exec svelte-kit sync           # regenerates .svelte-kit/tsconfig.json
cd extensions/rust-wasm && pnpm build && cd -   # wasm-pack output (requires Rust)
pnpm run build:doc-chunks           # builds src/lib/chat/docs-chunks.json
```

---

## 2. Repository Layout

The public branch ships the runtime app plus end-user documentation. The
top-level surfaces that you'll actually edit:

| Path | Purpose |
|------|---------|
| `src/lib/` | Frontend library — Svelte components + TypeScript utilities |
| `desktop/` | Tauri webview entry (`index.html`, `App.svelte`, etc.) |
| `src-tauri/` | Tauri Rust shell (window, IPC, sidecar binaries, app icons) |
| `server/` | FastAPI Python backend, MCP server, workflow engine, plugins |
| `extensions/` | VSCode extension + Rust-WASM bindings (`@catgo/ferrox-wasm`) |
| `docs/` | VitePress documentation site (guide / modules / tutorials / reference) |
| `tests/vitest/` | Frontend unit tests |
| `tests/playwright/` | End-to-end browser tests (legacy SvelteKit; currently best-effort) |
| `scripts/` | Build helpers — icon generator, doc chunker, backend bundler |

---

## 3. Tests & Checks

```bash
pnpm test                  # vitest run — frontend unit tests
pnpm check                 # svelte-check against ./tsconfig.json
```

The GitHub Actions Tests workflow (`.github/workflows/test.yml`) runs the
unit suite plus a Playwright job. Both rebuild the gitignored artifacts
(`.svelte-kit/`, `extensions/rust-wasm/pkg/`, `src/lib/chat/docs-chunks.json`)
before invoking the test runners — replicate those steps locally if your
results diverge from CI.

---

## 4. Working with AI Coding Assistants

CatGo's codebase is large; AI assistants work best when you tell them
exactly which files to look at instead of letting them grep blindly.

### Good prompt template

```
Please read the following files first:
1. <specific path 1>
2. <specific path 2>

Context: <one sentence of background>

Task: <clear action — "add", "fix", "refactor">

Constraints:
- <specific requirement>
- <specific requirement>

Verification: run `pnpm check` and `pnpm test` and report results.
```

### Plan-first workflow

For anything beyond a small fix, ask the assistant to plan first:

```
Read <relevant files>, then before writing any code, tell me:
1. Which files need to change
2. The proposed approach
3. Risks or things to watch out for

Wait for me to approve before editing.
```

### Where to point the assistant

| Goal | Files to read first |
|------|---------------------|
| Project overview | `readme.md` + `docs/guide/` |
| Frontend module behaviour | The relevant `src/lib/<area>/` directory |
| 3D structure viewer internals | `src/lib/structure/Structure.svelte` + `src/lib/structure/StructureScene.svelte` |
| Workflow engine | `src/lib/workflow/` (frontend) + `server/catgo/workflow/` (backend) |
| MCP server / agent tools | `server/server_claude_code.py` + `server/catgo/mcp/` |
| Build / bundle pipeline | `vite.desktop.config.ts`, `src-tauri/tauri.conf.json`, `scripts/build-backend.sh` |
| Plugin extensions | `extensions/` (vscode, rust-wasm, uff-relax, vsepr-rs) |

---

## 5. Coding Conventions

- **Frontend**: Svelte 5 (`$state` / `$derived` / `$effect`), TypeScript strict, ESLint config in `eslint.config.js`.
- **Backend**: Python 3.10+, FastAPI, ruff/black formatting. Tests under `server/tests/`.
- **Commit style**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`).
- **Branching**: feature work on a topic branch, PR into `main`.

---

## 6. Getting Help

- Search [existing issues](https://github.com/Hello-QM/catgo-LRG/issues) before opening a new one.
- For larger design discussions, open a GitHub Discussion.
- The README's "About" section lists the supported quantum chemistry / DFT
  engines (VASP, ORCA, CP2K, QE, GPAW, DFTB+, SIESTA, LAMMPS) — issues
  scoped to one engine help reviewers route the work.

Thanks again — happy hacking!

---

## Licensing of contributions

- Contributors must have the right to submit their work to CatGo.
- Third-party code must retain its original notices; copying it into CatGo does
  not relicense third-party code.
- Accepting a pull request does not by itself prove copyright assignment.
- Before accepting a contribution, maintainers may require a separate
  contributor agreement so the project has the right to license and enforce its
  code.
- Contributions to CatGo are accepted under AGPL-3.0-or-later.
- CatGo is licensed under AGPL-3.0-or-later. If CatGo contributes to your work,
  please include “This work used CatGo (https://catgo-ucsd.org).” and the
  preferred citation in CITATION.cff. This request is not an additional
  condition of the AGPL license.
