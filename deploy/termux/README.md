# Model A — THIN CatGo backend inside Termux (Android)

Run the CatGo backend **self-contained on an Android phone**. The backend serves
the prebuilt SPA and binds `0.0.0.0:8000`; you open `http://localhost:8000` in
the phone's browser. No external server, no separate frontend host.

## Prerequisites

1. **Termux** — install from **F-Droid** (the Google Play build is outdated/broken).
2. **Termux:API** app — also from F-Droid. Provides the `termux-wake-lock` CLI
   used to stop Android from suspending the backend. Optional but recommended.
3. A **prebuilt `build-desktop/`** frontend (see next section). The phone does
   **not** build the SPA — that is too heavy for a phone.

## Step 1 — build the frontend on a real machine, then copy it over

On a desktop/laptop checkout of this repo:

```bash
pnpm install
pnpm build:connect        # NON-static build; the SPA talks to a real backend
```

> Do **not** use `pnpm deploy:build` for this. That is `VITE_STATIC_ONLY=true`,
> which installs a 503 fetch interceptor that blocks all backend calls. Model A
> needs a real backend, so the **non-static** `build:connect` is required.

Both emit `build-desktop/` at the repo root. Copy it to the phone, e.g.:

```bash
scp -r build-desktop/  <phone-user>@<phone-ip>:/data/data/com.termux/files/home/catgo-repo/
# or use Termux's shared storage / a USB transfer
```

## Step 2 — run setup on the phone

From the repo on the phone (the folder containing `server/main.py`):

```bash
cd ~/catgo-repo
bash deploy/termux/setup-termux.sh
```

The script is idempotent and re-runnable. It installs system + Python deps,
finds `build-desktop/`, then launches the backend with `CATGO_THIN=1` and a
wake-lock. Useful variants:

```bash
./deploy/termux/setup-termux.sh /path/to/build-desktop      # explicit frontend dir
./deploy/termux/setup-termux.sh --repo /path/to/catgo-repo  # explicit repo
./deploy/termux/setup-termux.sh --no-run                    # install deps only
```

Then open **`http://localhost:8000`** in the phone's browser.

Tip: launch inside `tmux` (`tmux new -s catgo`) so the backend survives if the
shell/session closes; reattach with `tmux attach -t catgo`.

## What works vs. what's dropped in THIN mode

`CATGO_THIN=1` drops the heavy scientific-analysis routers (which need
`pymatgen.analysis` / `sklearn` / `openbabel`) — routers go 276 → 213.

| Feature | THIN mode |
| --- | --- |
| Terminal (pty) | ✅ works |
| HPC job submit (subprocess SSH) | ✅ works |
| Chat / CatBot | ✅ works |
| Trajectory viewer | ✅ works |
| Structure view (`structure_ops`) | ✅ works (still imports pymatgen) |
| pymatgen.analysis features (phase diagrams, etc.) | ❌ dropped |
| sklearn-based analysis | ❌ dropped |
| openbabel format conversion | ❌ dropped |

`pymatgen` and `ase` are still installed (and required for structure/trajectory);
they have aarch64 wheels, so the install succeeds on the phone.

## Wake-lock / battery-optimization caveat

Android aggressively suspends background apps. To keep the backend alive:

- Install the **Termux:API** app (the script calls `termux-wake-lock`; it
  guards gracefully if the app is missing, but then Android may freeze the
  process).
- Exclude Termux from battery optimization in Android settings
  (Settings → Apps → Termux → Battery → Unrestricted).
- Keep the Termux notification visible; don't swipe it away.

## HPC from the phone (ssh_config)

To submit jobs to a cluster from the phone:

- In the cluster profile, set `auth_method = ssh_config` and point it at a
  `Host` alias in `~/.ssh/config`. This uses the **subprocess `ssh` runner**
  (system `openssh`, installed by the script) rather than `asyncssh`, avoiding
  asyncssh quirks on Termux.
- The phone needs a network route to the login node — connect VPN / Tailscale
  (or be on the cluster's network) before submitting.

Example `~/.ssh/config`:

```
Host expanse
    HostName login.expanse.sdsc.edu
    User myuser
    IdentityFile ~/.ssh/id_ed25519
```

## iOS note

iOS has no Termux. The closest option, **iSH**, is an x86 emulation layer — it
is slow and flaky for this workload, and aarch64 wheels won't apply. **Android +
Termux is the recommended (and tested) path** for Model A. For iOS, prefer
Model C (phone browser → remote backend) instead.
