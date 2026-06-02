---
name: backend-doctor
description: >
  Diagnose and fix the CatGo backend. Use whenever the user asks to "check the
  backend", "diagnose the backend", "fix the backend", "why isn't X working",
  reports connection problems, a blank/failing UI, "router not loaded", "deps
  missing", or "can't reach the server". Reads GET /api/diagnostics, explains
  each issue from its fix_hint, auto-applies SAFE fixes (reconnect HPC, pip
  install a missing dep via the terminal), confirms risky actions first, and —
  if diagnostics itself is unreachable — tells the user how to start the backend
  instead of pretending to fix one that is down.
---

# Backend Doctor Skill

## When to Use

Use this skill when the user reports that CatGo itself is misbehaving (as
opposed to a specific DFT calculation):

- "check / diagnose / fix the backend"
- "why isn't X working", "the app is broken", "the page is blank"
- "I can't connect", "connection problems", "nothing loads"
- "a router is missing", "pymatgen / ase / asyncssh not installed"
- "HPC won't connect"

Do NOT use this skill for DFT/calculation errors (ZBRENT, SCF, POTCAR for a
specific job) — those route to the `troubleshooting` router.

## The diagnostics contract

Everything in this skill is driven by one endpoint. Call it first, every time:

```
GET /api/diagnostics
```

(If that path 404s on an older build, fall back to `GET /api/system/diagnostics`.)

The response shape is fixed:

```json
{
  "ok": true,
  "version": "<string>",
  "mode": "thin" | "full",
  "frontend_served": true,
  "routers": { "loaded": 42, "missing": ["<name>", ...] },
  "deps": { "pymatgen": true, "ase": true, "asyncssh": true, "numpy": true },
  "hpc": { "active_sessions": 0, "any_connected": false },
  "health": "ok" | "degraded",
  "issues": [
    { "id": "<slug>", "severity": "info"|"warn"|"error",
      "message": "<human>", "fix_hint": "<short how-to>" }
  ]
}
```

The **`issues` array is the source of truth.** Do not invent problems that are
not in it. Read `mode`, `deps`, `hpc`, and `health` for context, then work the
`issues` list one at a time.

## Procedure

### Step 1: Fetch diagnostics

```
GET /api/diagnostics
```

- If you get a valid JSON body back → the backend is **up**. Continue to Step 2.
- If the request fails to connect / times out / refuses → the backend is
  **down**. Jump to "Chicken-and-egg: diagnostics unreachable" below. Do NOT
  attempt any of the in-app fixes — none of them can work without the server.

### Step 2: Summarize state for the user

In one short block, report:
- `health` (ok / degraded) and `version`
- `mode` (thin = optional heavy deps deliberately excluded; full = everything)
- HPC: `hpc.any_connected` and `hpc.active_sessions`
- count of `issues` by severity

### Step 3: Work each issue

For every entry in `issues`, in `error` → `warn` → `info` order:
1. Restate `message` plainly (what is wrong and why it matters).
2. State the fix from `fix_hint`.
3. Classify the fix as **SAFE** (auto-apply, Step 4) or **RISKY** (confirm
   first, Step 5).

### Step 4: Auto-apply SAFE fixes

The backend already responded, so the terminal / pty endpoint and HPC routes
are reachable. SAFE fixes you may apply without asking:

- **Missing optional dep** (`deps.pymatgen`/`ase`/`asyncssh`/`numpy` is `false`,
  or a `dep_*` issue): install it in the backend's own environment via the
  terminal/pty endpoint, then re-run diagnostics to confirm.

  ```bash
  python -m pip install pymatgen      # or ase / asyncssh / numpy
  ```

  - If `mode == "thin"`, a missing heavy dep may be **expected** (thin mode
    deliberately omits them). Say so; only install if the user actually needs
    that feature. Do not "fix" a thin-mode omission silently.

- **HPC not connected** (`hpc.any_connected == false` while the user is trying
  to run jobs, or an `hpc_*` issue): guide a reconnect.

  ```json
  catgo_system(action: "status")
  ```

  Then reconnect through the HPC settings panel, and verify the SSH config
  (host, user, key, OTP freshness). After reconnecting:

  ```
  GET /api/diagnostics
  ```

  and confirm `hpc.any_connected` flipped to `true`.

After any SAFE fix, **re-fetch `GET /api/diagnostics`** and confirm the
corresponding issue is gone. Never claim it is fixed without the re-check.

### Step 5: Confirm RISKY actions first

Ask before doing anything that changes the environment or state beyond a single
optional-dep install or a reconnect. Examples that require explicit user
confirmation:

- restarting the backend process
- upgrading/downgrading/uninstalling an already-present package, or pinning a
  version that differs from what is installed
- editing `ssh_config`, credentials, or any settings file
- clearing caches, deleting run directories, or resetting workflow state
- installing system-level packages (anything beyond `python -m pip install`)

State exactly what you will run and what it affects, then wait for a yes.

### Step 6: Re-verify and report

Re-run `GET /api/diagnostics`. Report which issues cleared, which remain, and
the next concrete action for anything still red.

## Issue id reference

Match on the `id` slug (the backend owns the exact set; these are the common
ones). Always prefer the issue's own `fix_hint` over this table when they differ.

| Issue id (typical)        | Meaning                                   | Fix class | Action |
|---------------------------|-------------------------------------------|-----------|--------|
| `dep_pymatgen` / `deps.*` | An optional heavy dep failed to import    | SAFE*     | `python -m pip install <dep>`, then re-check. *Expected in `thin` mode. |
| `dep_asyncssh`            | asyncssh missing → no HPC/SSH             | SAFE      | `python -m pip install asyncssh`; HPC is dead until this resolves. |
| `router_missing`          | A router in `routers.missing` didn't load | RISKY     | Usually a missing dep or import error upstream; surface the underlying dep issue, confirm before any restart. |
| `hpc_no_session`          | `hpc.any_connected == false`              | SAFE      | Guide reconnect via HPC settings; verify ssh_config. |
| `frontend_not_served`     | `frontend_served == false`                | RISKY     | SPA build (build-desktop) absent; rebuilding is a heavier action — confirm first. |
| `thin_mode`               | `mode == "thin"`                          | INFO      | Informational; some features intentionally off. Don't "fix". |

## Chicken-and-egg: diagnostics unreachable

If `GET /api/diagnostics` (and `/api/system/diagnostics`) cannot be reached at
all, the backend is **not running**. None of the in-app fixes apply — do not
pretend to fix a server that is down. Instead, instruct the user to start it:

1. One-line installer / launcher:

   ```bash
   curl -sSL https://app.catgo-ucsd.org/install.sh | bash
   ```

2. Or, from a checkout, run the server directly:

   ```bash
   python server/main.py
   ```

Also have them confirm the frontend is pointed at the right backend URL: the
runtime backend-URL store (`catgo-backend-url` in localStorage, default
`http://localhost:8000`). If the backend is up on a different host/port, set
the backend URL to match rather than restarting anything.

Once the server is up, start over at Step 1.

## Key Principle

Diagnose from `/api/diagnostics` before prescribing. Work only the issues the
backend actually reports, auto-apply only the two SAFE classes (optional-dep
install, HPC reconnect), confirm everything else, and re-verify with a second
diagnostics call before claiming success. If diagnostics is unreachable, the
job is to get the backend running — not to fake a fix.
