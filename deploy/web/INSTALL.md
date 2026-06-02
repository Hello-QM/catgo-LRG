# CatGo backend — one-line installer

Stand up a local CatGo **thin backend** that the hosted web UI at
<https://app.catgo-ucsd.org> talks to. The UI runs in your browser; the backend
runs on your machine and does the local work (HPC SSH, structure parsing, etc.).

## Quick start

```bash
curl -sSL https://app.catgo-ucsd.org/install.sh | bash
```

Then:

1. Open <https://app.catgo-ucsd.org> in your browser.
2. When the wizard asks for a backend, enter `http://localhost:8000`
   (or just `localhost` — the wizard auto-detects the port).

The installer keeps the process in the foreground. Leave the terminal open
while you use CatGo; press **Ctrl+C** to stop.

## What it does

The script (`deploy/web/install.sh`):

1. **Detects your OS** (Linux or macOS) and a **Python 3.10+** interpreter.
   It errors with install guidance if either is missing.
2. **Gets the backend source.** If you run it from inside an existing CatGo
   checkout (it walks up the tree looking for `server/main.py`), it reuses that
   checkout. Otherwise it `git clone`s the repo into `~/.catgo-app`.
3. **Creates an isolated Python environment** — `uv venv` if [uv] is installed
   (faster), otherwise a stdlib `python3 -m venv` — at
   `<repo>/.catgo-venv`.
4. **Installs the thin backend dependencies** only:
   `fastapi`, `uvicorn` (plain, not `[standard]`), `pydantic`,
   `python-multipart`, `httpx`, `asyncssh`, `pymatgen`, `ase`.
   It uses `uv pip install` when `uv` is present, else `pip`.
5. **Launches the backend** with `CATGO_THIN=1` and
   `CATGO_ALLOWED_ORIGINS=https://app.catgo-ucsd.org`, binding `0.0.0.0:8000`
   via `python server/main.py`.

The script is **idempotent**: an existing clone is `git pull`ed, an existing
venv is reused, and dependencies are re-checked. Safe to re-run any time.

[uv]: https://docs.astral.sh/uv/

## Security

- The backend binds `0.0.0.0:8000` so the browser UI can reach it over
  localhost. **Keep it off the public internet** — do not forward port 8000
  through a firewall, router, or tunnel.
- CORS is restricted to the hosted origin (`https://app.catgo-ucsd.org`) via
  `CATGO_ALLOWED_ORIGINS`, so a random website cannot drive your backend.
  Anything that can already reach the port directly (e.g. other machines on
  your LAN) still can — run it on a machine you trust.

## Customizing

Override any of these by setting an environment variable before running, or by
editing the defaults at the top of `install.sh`.

| Variable | Default | Purpose |
|---|---|---|
| `CATGO_REPO` | `https://github.com/your-org/catgo.git` *(placeholder — edit this)* | Git URL cloned when not inside a checkout |
| `CATGO_APP_DIR` | `~/.catgo-app` | Where to clone the repo |
| `CATGO_ORIGIN` | `https://app.catgo-ucsd.org` | Allowed browser origin (CORS) |
| `CATGO_PORT` | `8000` | Port the backend binds |

> **Note:** `CATGO_REPO` ships as a placeholder. Edit it in `install.sh` to
> your real repository URL before publishing the one-liner, or pass it inline.

### Change the source repository

```bash
curl -sSL https://app.catgo-ucsd.org/install.sh | CATGO_REPO=https://github.com/your-org/catgo.git bash
```

### Change the origin or port

```bash
# Different port
curl -sSL https://app.catgo-ucsd.org/install.sh | CATGO_PORT=8123 bash

# Different allowed origin (e.g. a staging UI)
curl -sSL https://app.catgo-ucsd.org/install.sh | CATGO_ORIGIN=https://staging.catgo-ucsd.org bash
```

If you change `CATGO_PORT`, enter `http://localhost:<port>` in the wizard.

## Stopping the backend

- **Foreground:** press **Ctrl+C** in the terminal running the installer.
- **Find a stray process** (e.g. you closed the terminal but it kept running):

  ```bash
  # Linux / macOS
  lsof -ti tcp:8000 | xargs kill        # replace 8000 with your CATGO_PORT
  ```

## Re-running / updating

Run the same one-liner again. The installer pulls the latest source, reuses the
existing virtualenv, and re-checks dependencies before relaunching.

## Troubleshooting

- **`No Python 3.10+ interpreter found`** — install Python 3.10+:
  - Debian/Ubuntu: `sudo apt-get install -y python3 python3-venv python3-pip`
  - Fedora/RHEL: `sudo dnf install -y python3 python3-pip`
  - macOS: `brew install python@3.12`
- **`Required command 'git' not found`** — install git
  (`sudo apt-get install -y git` or `brew install git`).
- **Port already in use** — another backend may be running; stop it (see
  above) or pick a new port with `CATGO_PORT`.
- **Windows** — use WSL2, or run the backend manually from a checkout:
  `CATGO_THIN=1 CATGO_ALLOWED_ORIGINS=https://app.catgo-ucsd.org python server/main.py`.
