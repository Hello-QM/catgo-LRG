# Configuration Reference

CatGo reads configuration from environment variables, the in-app *Settings* dialog, and config files under `~/.catgo/`. Settings dialog changes take effect immediately; environment variable changes require a restart.

## User Data Directory

| Path | Contents |
|------|----------|
| `~/.catgo/` | Default root for all persistent user data |
| `~/.catgo/databases/` | SQLite databases (workflow state, panel state, structure cache) |
| `~/.catgo/agents/<provider>/` | CatBot working directory per provider |
| `~/.catgo/logs/` | Sidecar and agent logs |

Override the root with:

```bash
export CATGO_HOME=/path/to/your/dir
```

The override is honored on every platform and inside AppImage / `.deb` / `.dmg` builds.

## Environment Variables

### Application

| Variable | Default | Purpose |
|----------|---------|---------|
| `CATGO_HOME` | `~/.catgo` | Root for user data, databases, agent dirs |
| `CATGO_LOG_LEVEL` | `info` | One of `trace`, `debug`, `info`, `warn`, `error` |
| `CATGO_SERVER_PORT` | `8000` | Python backend port |
| `CATGO_AGENT_PORT` | `8765` | `catgo-agent` Node sidecar port |
| `PYTHON` | from `PATH` | Path to the Python interpreter used by the dev frontend |

### AI Providers (CatBot)

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Claude |
| `GEMINI_API_KEY` | Gemini |
| `OPENAI_API_KEY` | Codex |

Keys can also be entered in *Settings → Chat*; the in-app dialog stores them encrypted in the OS keychain (Keychain on macOS, Credential Manager on Windows, libsecret on Linux).

### Materials Databases

| Variable | Purpose |
|----------|---------|
| `MP_API_KEY` | Materials Project (required for MP queries) |
| `OPTIMADE_PROVIDERS` | Comma-separated list of OPTIMADE provider IDs to query |

### HPC

| Variable | Purpose |
|----------|---------|
| `VASP_PSP_DIR` | Path to the VASP PAW potentials (used by the POTCAR generator) |
| `CATGO_HPC_DEFAULT` | Default HPC host nickname (matches an entry in *Settings → HPC*) |

## Config Files

`~/.catgo/config.json` — global app preferences (theme, viewer defaults, calculator defaults). Edit through *Settings* whenever possible.

`~/.catgo/hpc.json` — HPC host registry. Format:

```json
{
  "hosts": [
    {
      "nickname": "shaheen",
      "hostname": "shaheen.hpc.kaust.edu.sa",
      "user": "you",
      "key_path": "~/.ssh/id_ed25519",
      "scheduler": "slurm",
      "workdir": "/scratch/you/catgo"
    }
  ]
}
```

`~/.catgo/agents/<provider>/settings.json` — per-provider CatBot settings (system prompt, allowed tools, default panel).

## Backend Endpoints

The Python sidecar exposes these HTTP endpoints. Token-efficient operations (file upload, structure export, panel mutations) should always go through these rather than through the MCP server.

| Endpoint | Purpose |
|----------|---------|
| `/api/view/upload-and-load` | Multipart upload + load into viewer |
| `/api/view/structure/export?format=…` | Download current structure |
| `/api/view/structure/merge-upload` | Multipart upload + merge into current panel |
| `/api/workflow/*` | Workflow engine CRUD + control |
| `/api/mcp/` | MCP protocol endpoint (for external agents) |
| `/health` | Liveness probe |

See [Server API](/tutorials/server/server-api) for full request/response schemas.
