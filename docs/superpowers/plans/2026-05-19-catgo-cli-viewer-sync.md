# CatGO CLI — P3a Viewer Sync + Auto-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `catgo push` and `catgo pull` ops that move structures between the CLI Session and the live CatGO viewer, with transparent on-demand spawn of `catgo serve --daemon` when no server is reachable.

**Architecture:** New `ServerLink` (stdlib `urllib.request`) wraps the existing `/api/view/upload-and-load` and `/api/view/structure/export` endpoints. `Session.link` is populated by `ServerLink.discover()` at CLI entry (probe `:8000`→`:33413`). When a `needs_server` op runs with `link=None`, the CLI spawns `catgo serve --daemon` and polls `/health` with exponential backoff (≤20 s). `--no-autostart` opts out.

**Tech Stack:** Python 3.11, P1/P2 CLI infra, stdlib `urllib.request` + `subprocess.Popen` (no new dependency), pytest with `monkeypatch` for the HTTP + spawn boundaries (CI never starts a real daemon).

Spec: `docs/superpowers/specs/2026-05-19-catgo-cli-viewer-sync-design.md`. Branch `feature/catgo-cli-viewer-sync` (off `feature/catgo-cli-analyze` HEAD `33baad6d`); independent PR base = `feature/catgo-cli-analyze`. Work from `/home/james0001/project/catgo-LRG`; tests run `cd server && python -m pytest tests/cli/ -v`. Every task: confirm `git rev-parse --abbrev-ref HEAD` == `feature/catgo-cli-viewer-sync` (checkout if detached at same commit; never reset/rebase/touch main or earlier branches).

Endpoints (verified):
- `GET /health` and `GET /api/health` (main.py)
- `POST /api/view/upload-and-load?panel_id=<id>` (multipart `file=`)
- `GET /api/view/structure/export?format=<f>&panel_id=<id>` → text body
- daemon: `python -m catgo serve --daemon` (P1 cmd, listens on :8000)

---

## File Structure

- `server/catgo/cli/server_link.py` — `ServerLink(base_url)`; `discover()`, `push_structure()`, `pull_structure()`; `_ping`, `_extract_detail` helpers; stdlib only.
- `server/catgo/cli/_autostart.py` — `spawn_daemon_and_wait(timeout=20.0) -> ServerLink`; uses `subprocess.Popen` + backoff poll.
- `server/catgo/cli/ops_viewer.py` — `push` / `pull` handlers `(session, params) -> OpResult`.
- `server/catgo/cli/ops.py` (P1) — append 2 `registry.add(...)` calls with `group="viewer"`, `needs_server=True`.
- `server/catgo/cli/__init__.py` — `main`: extract `--no-autostart` before empty-argv check; `_run_op`: `ServerLink.discover()` after `Session()`, needs_server-triggered auto-start hook (or clean exit 2 if `--no-autostart`).
- `server/catgo/cli/shell.py` — `InteractiveShell(no_autostart=False)`; `ServerLink.discover()` in `__init__`; needs_server hook before handler call.
- `server/catgo/cli/session.py` — tighten `link` annotation `Optional["ServerLink"]` (no behavior change).
- Tests: `server/tests/cli/test_server_link.py`, `test_autostart.py`, `test_ops_viewer.py`, append to `test_argparse.py` / `test_equivalence.py` / `test_shell.py`.

---

### Task 1: `ServerLink.discover` + `_ping`

**Files:**
- Create: `server/catgo/cli/server_link.py`
- Test: `server/tests/cli/test_server_link.py`

- [ ] **Step 1: Write the failing test**

`server/tests/cli/test_server_link.py`:

```python
import pytest
from catgo.cli.server_link import ServerLink


def test_discover_finds_8000(monkeypatch):
    from catgo.cli import server_link
    monkeypatch.setattr(server_link, "_ping",
                        lambda url: url == "http://localhost:8000/health")
    link = ServerLink.discover()
    assert link is not None
    assert link.base_url == "http://localhost:8000"


def test_discover_falls_back_to_33413(monkeypatch):
    from catgo.cli import server_link
    monkeypatch.setattr(server_link, "_ping",
                        lambda url: url == "http://localhost:33413/health")
    link = ServerLink.discover()
    assert link is not None
    assert link.base_url == "http://localhost:33413"


def test_discover_returns_none_when_both_down(monkeypatch):
    from catgo.cli import server_link
    monkeypatch.setattr(server_link, "_ping", lambda url: False)
    assert ServerLink.discover() is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_server_link.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.cli.server_link'`

- [ ] **Step 3: Write minimal implementation**

`server/catgo/cli/server_link.py`:

```python
"""HTTP link to a running CatGO server. Stdlib urllib, no new deps.

Port-probe convention follows the catgo-load / catgo-pull skills:
:8000 first (lab box running `catgo serve`), :33413 second (reverse
tunnel from the user's laptop).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

from catgo.cli.adapter import OpError


def _ping(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=0.5) as r:
            return 200 <= getattr(r, "status", 200) < 300
    except Exception:  # noqa: BLE001
        return False


def _extract_detail(exc: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(exc.read())
        return str(body.get("detail", exc))
    except Exception:  # noqa: BLE001
        return f"HTTP {exc.code}"


@dataclass
class ServerLink:
    base_url: str

    @classmethod
    def discover(cls) -> "ServerLink | None":
        for port in (8000, 33413):
            url = f"http://localhost:{port}"
            if _ping(f"{url}/health"):
                return cls(base_url=url)
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_server_link.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/server_link.py server/tests/cli/test_server_link.py
git commit -m "feat(cli): ServerLink scaffold + :8000->:33413 discover

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: `ServerLink.push_structure` (multipart POST)

**Files:**
- Modify: `server/catgo/cli/server_link.py` (add method)
- Test: `server/tests/cli/test_server_link.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_server_link.py`:

```python
import io


class _FakeResponse:
    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status
    def read(self) -> bytes:
        return self._body
    def __enter__(self): return self
    def __exit__(self, *a): pass


def test_push_structure_posts_multipart(monkeypatch, tmp_path):
    from catgo.cli import server_link
    calls = {}
    def _urlopen(req, timeout=None):
        calls["url"] = req.full_url
        calls["method"] = req.get_method()
        calls["content_type"] = req.headers.get("Content-type", "")
        calls["body"] = req.data
        return _FakeResponse(b'{"panel_id": "default", "num_sites": 4}')
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    p = tmp_path / "x.vasp"; p.write_bytes(b"POSCAR\n1.0\n")
    link = server_link.ServerLink(base_url="http://localhost:8000")
    resp = link.push_structure(p, panel_id="default")
    assert calls["method"] == "POST"
    assert calls["url"].startswith("http://localhost:8000/api/view/upload-and-load")
    assert "panel_id=default" in calls["url"]
    assert calls["content_type"].startswith("multipart/form-data; boundary=")
    assert b'filename="x.vasp"' in calls["body"]
    assert b"POSCAR" in calls["body"]
    assert resp == {"panel_id": "default", "num_sites": 4}


def test_push_structure_4xx_raises_operror(monkeypatch, tmp_path):
    from catgo.cli import server_link
    from catgo.cli.adapter import OpError
    err_body = b'{"detail": "bad file"}'
    def _urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 400, "Bad Request", {},
            io.BytesIO(err_body))
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    import urllib.error
    p = tmp_path / "x.vasp"; p.write_bytes(b"x")
    link = server_link.ServerLink(base_url="http://localhost:8000")
    with pytest.raises(OpError) as ei:
        link.push_structure(p, panel_id=None)
    assert "bad file" in str(ei.value)
```

(NOTE: import `urllib.error` inside `test_push_structure_4xx_raises_operror` is fine; pytest collects it locally.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_server_link.py -k push -v`
Expected: FAIL — `AttributeError: 'ServerLink' object has no attribute 'push_structure'`

- [ ] **Step 3: Write minimal implementation**

Add to `server/catgo/cli/server_link.py` (inside the `ServerLink` class, after `discover`):

```python
    def push_structure(self, path, panel_id) -> dict:
        """POST /api/view/upload-and-load (multipart). Returns server JSON."""
        import os
        from pathlib import Path
        p = Path(path)
        boundary = "----catgo-cli-" + os.urandom(8).hex()
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; '
            f'filename="{p.name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + p.read_bytes() + f"\r\n--{boundary}--\r\n".encode()

        url = f"{self.base_url}/api/view/upload-and-load"
        if panel_id:
            url += f"?panel_id={panel_id}"
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type":
                     f"multipart/form-data; boundary={boundary}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            raise OpError(f"server error: {_extract_detail(exc)}") from exc
        except urllib.error.URLError as exc:
            raise OpError(
                f"server connection failed: {exc.reason}") from exc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_server_link.py -v`
Expected: PASS (5 passed = 3 prior + 2 new)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/server_link.py server/tests/cli/test_server_link.py
git commit -m "feat(cli): ServerLink.push_structure (multipart POST)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: `ServerLink.pull_structure` (GET text body)

**Files:**
- Modify: `server/catgo/cli/server_link.py` (add method)
- Test: `server/tests/cli/test_server_link.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_server_link.py`:

```python
def test_pull_structure_get_with_format(monkeypatch):
    from catgo.cli import server_link
    calls = {}
    def _urlopen(req, timeout=None):
        calls["url"] = req.full_url
        calls["method"] = req.get_method()
        return _FakeResponse(b"POSCAR\n1.0\n...")
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    link = server_link.ServerLink(base_url="http://localhost:33413")
    data = link.pull_structure(fmt="poscar", panel_id="structure-1")
    assert calls["method"] == "GET"
    assert calls["url"].startswith(
        "http://localhost:33413/api/view/structure/export?format=poscar")
    assert "panel_id=structure-1" in calls["url"]
    assert data.startswith(b"POSCAR")


def test_pull_structure_panel_omitted(monkeypatch):
    from catgo.cli import server_link
    calls = {}
    def _urlopen(req, timeout=None):
        calls["url"] = req.full_url
        return _FakeResponse(b"x")
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    link = server_link.ServerLink(base_url="http://localhost:8000")
    link.pull_structure(fmt="cif", panel_id=None)
    assert "panel_id=" not in calls["url"]
    assert "format=cif" in calls["url"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_server_link.py -k pull -v`
Expected: FAIL — `AttributeError: 'ServerLink' object has no attribute 'pull_structure'`

- [ ] **Step 3: Write minimal implementation**

Add to `server/catgo/cli/server_link.py` (after `push_structure` in the class):

```python
    def pull_structure(self, fmt, panel_id) -> bytes:
        """GET /api/view/structure/export?format=<f>[&panel_id=<id>].
        Returns the structure-file bytes."""
        url = f"{self.base_url}/api/view/structure/export?format={fmt}"
        if panel_id:
            url += f"&panel_id={panel_id}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            raise OpError(f"server error: {_extract_detail(exc)}") from exc
        except urllib.error.URLError as exc:
            raise OpError(
                f"server connection failed: {exc.reason}") from exc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_server_link.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/server_link.py server/tests/cli/test_server_link.py
git commit -m "feat(cli): ServerLink.pull_structure (GET export)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: `_autostart.spawn_daemon_and_wait`

**Files:**
- Create: `server/catgo/cli/_autostart.py`
- Test: `server/tests/cli/test_autostart.py`

- [ ] **Step 1: Write the failing test**

`server/tests/cli/test_autostart.py`:

```python
import sys
import pytest
from catgo.cli._autostart import spawn_daemon_and_wait
from catgo.cli.adapter import OpError


class _FakeProc:
    def __init__(self):
        self.stderr = None


def test_spawn_succeeds_when_health_responds(monkeypatch):
    from catgo.cli import _autostart, server_link
    popen_calls = {}
    def _popen(cmd, **kw):
        popen_calls["cmd"] = cmd
        popen_calls["start_new_session"] = kw.get("start_new_session")
        return _FakeProc()
    monkeypatch.setattr(_autostart.subprocess, "Popen", _popen)
    monkeypatch.setattr(_autostart.time, "sleep", lambda s: None)
    # discover returns a real link after the first poll
    monkeypatch.setattr(
        server_link.ServerLink, "discover",
        classmethod(lambda cls: server_link.ServerLink(
            base_url="http://localhost:8000")))
    link = spawn_daemon_and_wait(timeout=20.0)
    assert link.base_url == "http://localhost:8000"
    assert popen_calls["cmd"] == [sys.executable, "-m", "catgo",
                                   "serve", "--daemon"]
    assert popen_calls["start_new_session"] is True


def test_spawn_times_out_raises_operror(monkeypatch):
    from catgo.cli import _autostart, server_link
    monkeypatch.setattr(_autostart.subprocess, "Popen",
                        lambda *a, **k: _FakeProc())
    monkeypatch.setattr(_autostart.time, "sleep", lambda s: None)
    monkeypatch.setattr(server_link.ServerLink, "discover",
                        classmethod(lambda cls: None))
    with pytest.raises(OpError) as ei:
        spawn_daemon_and_wait(timeout=0.05)
    assert "failed to start" in str(ei.value).lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_autostart.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.cli._autostart'`

- [ ] **Step 3: Write minimal implementation**

`server/catgo/cli/_autostart.py`:

```python
"""Spawn `catgo serve --daemon` for needs_server CLI ops, poll /health."""
from __future__ import annotations

import subprocess
import sys
import time

from catgo.cli.adapter import OpError
from catgo.cli.server_link import ServerLink


def spawn_daemon_and_wait(timeout: float = 20.0) -> ServerLink:
    """Spawn the daemon and poll /health with exponential backoff.

    Raises OpError on spawn failure or timeout. Does NOT kill the spawned
    process on timeout (port may already be in use by another service).
    """
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "catgo", "serve", "--daemon"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001
        raise OpError(f"backend spawn failed: {exc}") from exc

    delay = 0.2
    waited = 0.0
    while waited < timeout:
        link = ServerLink.discover()
        if link is not None:
            return link
        time.sleep(delay)
        waited += delay
        delay = min(delay * 2, 2.0)

    err_tail = ""
    if proc.stderr is not None:
        try:
            err_tail = proc.stderr.read(1024).decode(errors="replace")
        except Exception:  # noqa: BLE001
            pass
    raise OpError(
        f"backend failed to start within {timeout:.0f}s; "
        f"try `catgo serve` manually. stderr: {err_tail!r}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_autostart.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/_autostart.py server/tests/cli/test_autostart.py
git commit -m "feat(cli): spawn catgo serve --daemon + poll /health for needs_server ops

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: `push` handler

**Files:**
- Create: `server/catgo/cli/ops_viewer.py` (push only)
- Test: `server/tests/cli/test_ops_viewer.py`

- [ ] **Step 1: Write the failing test**

`server/tests/cli/test_ops_viewer.py`:

```python
import pytest
from pathlib import Path
from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session
from catgo.cli import ops_viewer
from catgo.cli.adapter import OpError


class _FakeLink:
    def __init__(self):
        self.pushed = []
    def push_structure(self, path, panel_id):
        self.pushed.append((Path(path).name, panel_id,
                            Path(path).read_bytes()[:6]))
        return {"panel_id": panel_id or "default", "num_sites": 1}


def _cu():
    return Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]])


def test_push_from_session_structure(tmp_path):
    s = Session(); s.structure = _cu(); s.link = _FakeLink()
    r = ops_viewer.push(s, {"panel": ""})
    assert r.ok and "pushed" in r.message and "panel=default" in r.message
    assert s.link.pushed and s.link.pushed[0][1] is None  # panel "" -> None


def test_push_from_file(tmp_path):
    src = tmp_path / "in.vasp"
    _cu().to(filename=str(src), fmt="poscar")
    s = Session(); s.link = _FakeLink()
    r = ops_viewer.push(s, {"input": str(src), "panel": "structure-1"})
    assert r.ok and "panel=structure-1" in r.message
    assert s.link.pushed[0][0] == "in.vasp"
    assert s.link.pushed[0][1] == "structure-1"


def test_push_no_input_no_session_errors():
    s = Session(); s.link = _FakeLink()
    with pytest.raises(OpError):
        ops_viewer.push(s, {"panel": ""})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_ops_viewer.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.cli.ops_viewer'`

- [ ] **Step 3: Write minimal implementation**

`server/catgo/cli/ops_viewer.py`:

```python
"""viewer-group handlers: push / pull. (session, params) -> OpResult.

needs_server=True at the registry layer; auto-start hook in
__init__/_run_op + shell.run ensures session.link is set before the
handler runs.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from catgo.cli.adapter import OpError
from catgo.cli.registry import OpResult


def push(session, params: dict) -> OpResult:
    inp = params.get("input")
    panel = params.get("panel") or None   # "" -> None (server picks)
    link = session.link
    if link is None:
        raise OpError("push: server link unavailable (auto-start hook bug)")

    if inp:
        src = Path(inp)
        if not src.exists():
            raise OpError(f"push input not found: {src}")
        resp = link.push_structure(src, panel)
    else:
        if session.structure is None:
            raise OpError(
                "push requires <input> file or a loaded session structure")
        with tempfile.NamedTemporaryFile(
                suffix=".vasp", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            session.save(tmp_path)
            resp = link.push_structure(tmp_path, panel)
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass

    s = session.structure
    formula = s.composition.reduced_formula if s is not None else "?"
    nsites = s.num_sites if s is not None else resp.get("num_sites", "?")
    panel_used = resp.get("panel_id", panel or "default")
    return OpResult(
        ok=True,
        message=f"pushed {formula} ({nsites} sites) -> viewer panel={panel_used}",
        artifact=None, structure=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_ops_viewer.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/ops_viewer.py server/tests/cli/test_ops_viewer.py
git commit -m "feat(cli): push handler — file or session structure to viewer

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: `pull` handler

**Files:**
- Modify: `server/catgo/cli/ops_viewer.py` (add `pull`)
- Test: `server/tests/cli/test_ops_viewer.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_ops_viewer.py`:

```python
class _PullLink:
    def __init__(self, body: bytes):
        self._body = body
        self.calls = []
    def pull_structure(self, fmt, panel_id):
        self.calls.append((fmt, panel_id))
        return self._body


def test_pull_updates_session_structure(tmp_path):
    # The server returns a POSCAR; pull writes it into session.structure.
    poscar = (
        "Cu\n1.0\n3.61 0 0\n0 3.61 0\n0 0 3.61\n"
        "Cu\n1\nDirect\n0.0 0.0 0.0\n").encode()
    s = Session(); s.link = _PullLink(poscar)
    r = ops_viewer.pull(s, {"panel": "", "format": "poscar"})
    assert r.ok and "pulled" in r.message and "panel=default" in r.message
    assert s.structure is not None and s.structure.num_sites == 1
    assert s.link.calls == [("poscar", None)]


def test_pull_with_out_writes_file(tmp_path):
    poscar = (
        "Cu\n1.0\n3.61 0 0\n0 3.61 0\n0 0 3.61\n"
        "Cu\n1\nDirect\n0.0 0.0 0.0\n").encode()
    out = tmp_path / "viewed.vasp"
    s = Session(); s.link = _PullLink(poscar)
    r = ops_viewer.pull(s, {"panel": "structure-1", "format": "poscar",
                            "out": str(out)})
    assert r.ok and out.exists()
    # server bytes preserved verbatim (no pymatgen round-trip mangling)
    assert out.read_bytes() == poscar
    assert "-> " + str(out) in r.message
    assert "panel=structure-1" in r.message


def test_pull_unparseable_bytes_wrapped_as_operror():
    s = Session(); s.link = _PullLink(b"this is not a structure file")
    with pytest.raises(OpError) as ei:
        ops_viewer.pull(s, {"panel": "", "format": "poscar"})
    assert "unparseable poscar" in str(ei.value)
    assert s.structure is None      # half-success not allowed
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_ops_viewer.py -k pull -v`
Expected: FAIL — `AttributeError: module 'catgo.cli.ops_viewer' has no attribute 'pull'`

- [ ] **Step 3: Write minimal implementation**

Append to `server/catgo/cli/ops_viewer.py`:

```python
_FMT_EXT = {"poscar": ".vasp", "cif": ".cif", "xyz": ".xyz",
            "extxyz": ".extxyz"}


def pull(session, params: dict) -> OpResult:
    from catgo.cli.session import SessionError
    panel = params.get("panel") or None
    fmt = params.get("format", "poscar")
    link = session.link
    if link is None:
        raise OpError("pull: server link unavailable (auto-start hook bug)")

    data = link.pull_structure(fmt, panel)
    out = params.get("out")

    if out:
        # -o given: write the server's bytes verbatim to the user's path
        # (preserves CIF comments / extxyz columns / etc. that a pymatgen
        # round-trip would mangle). One write, atomic: if this fails, the
        # session is NOT yet mutated.
        target_path = Path(out)
        target_path.write_bytes(data)
        cleanup: "Path | None" = None
    else:
        # No -o: stage to a tempfile only so session.load can dispatch on
        # the extension; unlinked in finally.
        ext = _FMT_EXT.get(fmt, ".vasp")
        with tempfile.NamedTemporaryFile(suffix=ext, mode="wb",
                                          delete=False) as tmp:
            tmp.write(data)
            target_path = Path(tmp.name)
        cleanup = target_path

    try:
        try:
            session.load(target_path)
        except SessionError as exc:
            raise OpError(
                f"pull: server returned unparseable {fmt}: {exc}") from exc
    finally:
        if cleanup is not None:
            try:
                cleanup.unlink()
            except OSError:
                pass

    suffix = f" -> {out}" if out else ""

    s = session.structure
    formula = s.composition.reduced_formula if s is not None else "?"
    nsites = s.num_sites if s is not None else "?"
    return OpResult(
        ok=True,
        message=f"pulled {formula} ({nsites} sites) <- viewer "
                f"panel={panel or 'default'}{suffix}",
        artifact=Path(out) if out else None,
        structure=s)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_ops_viewer.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/ops_viewer.py server/tests/cli/test_ops_viewer.py
git commit -m "feat(cli): pull handler — viewer -> session.structure (+ optional -o)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Register push/pull in `ops.py` + dual-form equivalence

**Files:**
- Modify: `server/catgo/cli/ops.py` (append 2 ops)
- Test: `server/tests/cli/test_equivalence.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_equivalence.py`:

```python
def test_viewer_ops_registered():
    reg = build_registry()
    push = reg.get("push")
    pull = reg.get("pull")
    assert push.group == "viewer" and push.needs_server is True
    assert push.mutates is False
    assert pull.group == "viewer" and pull.needs_server is True
    assert pull.mutates is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_equivalence.py -k viewer -v`
Expected: FAIL — `KeyError: 'push'`

- [ ] **Step 3: Write minimal implementation**

In `server/catgo/cli/ops.py`'s `build_registry()`, after the existing `from catgo.cli import ops_analyze` block (Task 10 of P2), add:

```python
    from catgo.cli import ops_viewer
    reg.add(Operation(
        name="push", group="viewer",
        summary="upload structure to the CatGO viewer (auto-starts server)",
        params=[
            Param("panel", str, default="",
                  help="viewer panel id (empty = server default)"),
        ],
        handler=ops_viewer.push, needs_server=True, mutates=False))
    reg.add(Operation(
        name="pull", group="viewer",
        summary="download current viewer structure into the session",
        params=[
            Param("panel", str, default="",
                  help="viewer panel id (empty = server default)"),
            Param("format", str, default="poscar",
                  choices=["poscar", "cif", "xyz", "extxyz"],
                  help="export format"),
        ],
        handler=ops_viewer.pull, needs_server=True, mutates=True))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/ -v`
Expected: PASS — new equivalence test passes; full count ~85 passed + 3 skipped, ZERO failures.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/ops.py server/tests/cli/test_equivalence.py
git commit -m "feat(cli): register push/pull as needs_server viewer ops

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: `--no-autostart` global flag + `_run_op` auto-start hook

**Files:**
- Modify: `server/catgo/cli/__init__.py`
- Test: `server/tests/cli/test_argparse.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_argparse.py`:

```python
def test_no_autostart_global_flag_listed():
    r = _run_catgo("--help")
    assert r.returncode == 0
    assert "--no-autostart" in r.stdout


def test_push_without_server_with_no_autostart_clean_exit(tmp_path):
    # No CatGO server running in CI; --no-autostart must NOT spawn one.
    r = _run_catgo("--no-autostart", "push", "--panel", "default")
    assert r.returncode == 2
    assert "--no-autostart" in r.stderr
    assert "unreachable" in r.stderr.lower() or "server" in r.stderr.lower()
    assert "Traceback" not in r.stderr


def test_no_autostart_after_subcommand_also_works(tmp_path):
    # Users will type the flag in either position; both must work.
    r = _run_catgo("push", "--no-autostart", "--panel", "default")
    assert r.returncode == 2, r.stderr
    assert "unrecognized" not in r.stderr  # not an argparse rejection
    assert "--no-autostart" in r.stderr or "server" in r.stderr.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_argparse.py -k autostart -v`
Expected: FAIL — `--help` doesn't list `--no-autostart`; second test has wrong exit/stderr.

- [ ] **Step 3: Write minimal implementation**

In `server/catgo/cli/__init__.py`:

(a) In `_build_legacy_parser`, immediately AFTER `parser = argparse.ArgumentParser(...)` and BEFORE `sub = parser.add_subparsers(...)`, add:

```python
    parser.add_argument(
        "--no-autostart", action="store_true", dest="no_autostart",
        help="do not auto-spawn `catgo serve --daemon` for needs_server ops")
```

(b) In `_run_op`, AFTER `session = Session()` and BEFORE the existing `try:` that does `session.load(args.input)`, insert:

```python
    from catgo.cli.server_link import ServerLink
    session.link = ServerLink.discover()
    if op.needs_server and session.link is None:
        if getattr(args, "no_autostart", False):
            print("error: --no-autostart: server unreachable; "
                  "start `catgo serve` first", file=sys.stderr)
            return 2
        try:
            from catgo.cli._autostart import spawn_daemon_and_wait
            session.link = spawn_daemon_and_wait()
        except OpError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
```

(`OpError` import: already at function-local scope via `from catgo.cli.adapter import OpError`. If not in scope yet, add `from catgo.cli.adapter import OpError` to the top of the local imports.)

(c) In `main`, BEFORE the empty-argv shell branch, extract `--no-autostart` so the shell path also honors it:

```python
def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    # Top-level argparse flags don't propagate into subparsers, so a
    # user typing `catgo push --no-autostart` would otherwise fail with
    # "unrecognized arguments". Strip --no-autostart from wherever it
    # appears and re-prepend it before the (sub)command so the top-level
    # parser always sees it.
    no_auto = "--no-autostart" in argv
    effective = [a for a in argv if a != "--no-autostart"]
    parser, sub = _build_legacy_parser()
    _add_op_subparsers(sub)
    if not effective:
        from catgo.cli.shell import InteractiveShell
        InteractiveShell(no_autostart=no_auto).run()
        return
    args = parser.parse_args(
        (["--no-autostart"] if no_auto else []) + effective)
    if not getattr(args, "command", None):
        parser.print_help()
        return
    if hasattr(args, "_op"):
        raise SystemExit(_run_op(args))
    args.func(args)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_argparse.py -v`
Expected: PASS — `--help` lists `--no-autostart`; `_run_catgo("--no-autostart", "push", ...)` exits 2 with clean stderr.

NOTE: Task 9 below extends `InteractiveShell.__init__` to accept `no_autostart`; if Task 8's test_push_without_server_with_no_autostart_clean_exit subprocess test runs before Task 9 lands, the empty-argv shell branch above will raise `TypeError: __init__() got an unexpected keyword argument 'no_autostart'`. The argv-present path (which the test uses) is unaffected. If Task 8's tests still fail because of unrelated Task-9 dependencies, defer the `InteractiveShell(no_autostart=no_auto)` change to Task 9 (keep `InteractiveShell().run()` here for now) — the argparse path is what matters for Task 8.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/__init__.py server/tests/cli/test_argparse.py
git commit -m "feat(cli): --no-autostart global flag + _run_op needs_server hook

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: `InteractiveShell` discover + needs_server hook

**Files:**
- Modify: `server/catgo/cli/shell.py`
- Test: `server/tests/cli/test_shell.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_shell.py`:

```python
def test_shell_no_autostart_blocks_push():
    # Without a real server and with no_autostart=True, choosing `push`
    # in the menu must NOT spawn a daemon; the shell surfaces a clean
    # OpError-format line and returns to the menu.
    out = []
    script = iter(["push", "", "q"])   # op name, panel (empty), quit
    sh = InteractiveShell(session=Session(),
                          no_autostart=True,
                          input_fn=lambda _="": next(script),
                          output_fn=lambda *a, **k: out.append(
                              " ".join(map(str, a))))
    sh.run()
    text = "\n".join(out)
    assert "no-autostart" in text or "unreachable" in text.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_shell.py -k no_autostart -v`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'no_autostart'`

- [ ] **Step 3: Write minimal implementation**

In `server/catgo/cli/shell.py`:

(a) Replace `InteractiveShell.__init__` signature and body to add `no_autostart` + `ServerLink.discover()`:

```python
    def __init__(self, session: Session | None = None,
                 input_fn: Callable[[str], str] = input,
                 output_fn: Callable[..., None] = print,
                 no_autostart: bool = False) -> None:
        self.session = session or Session()
        self.reg = build_registry()
        self._in = input_fn
        self._out = output_fn
        self._no_autostart = no_autostart
        try:
            from catgo.cli.server_link import ServerLink
            self.session.link = ServerLink.discover()
        except Exception:  # noqa: BLE001
            self.session.link = None
```

(b) In `run`, the existing op-dispatch branch (already enhanced in P2 with the analyze input-path pre-prompt) — insert the needs_server hook BEFORE the analyze input-prompt check. Locate:

```python
                elif choice in self.reg.names():
                    op = self.reg.get(choice)
                    # Analyze ops read a DFT output file directly...
```

REPLACE the whole branch with:

```python
                elif choice in self.reg.names():
                    op = self.reg.get(choice)
                    if op.needs_server and self.session.link is None:
                        if self._no_autostart:
                            raise OpError(
                                "--no-autostart: server unreachable; "
                                "start `catgo serve` first")
                        from catgo.cli._autostart import (
                            spawn_daemon_and_wait,
                        )
                        self.session.link = spawn_daemon_and_wait()
                    # Analyze ops read a DFT output file directly (not the
                    # active session structure); argparse takes that as
                    # the positional `input`. From the menu we must prompt
                    # explicitly so the handler has params["input"].
                    pre_params: dict = {}
                    if op.group == "analyze":
                        ip = self._in("input path: ").strip()
                        if not ip:
                            raise OpError(
                                f"{op.name} requires an input file path")
                        pre_params["input"] = ip
                    params = {**pre_params, **self._prompt_params(op)}
                    if op.mutates:
                        self.session.push_history()
                    res = op.handler(self.session, params)
                    if res.structure is not None:
                        self.session.structure = res.structure
                    self._out(res.message)
```

The pre-existing `except (SessionError, OpError)` boundary in `run` catches the new OpError and prints it cleanly — the loop survives.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_shell.py -v`
Expected: PASS — new `test_shell_no_autostart_blocks_push` passes. Full `cd server && python -m pytest tests/cli/ -q` → all pass + 3 skipped, zero failures.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/shell.py server/tests/cli/test_shell.py
git commit -m "feat(cli): shell ServerLink.discover + needs_server hook (--no-autostart safe)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: Tighten `Session.link` annotation

**Files:**
- Modify: `server/catgo/cli/session.py`
- Test: `server/tests/cli/test_session.py` (no behavior change, no new test required)

- [ ] **Step 1: No new test needed (annotation-only change)**

Existing `test_session.py` continues to assert behavior; annotation drift would not break runtime.

- [ ] **Step 2: Make the change**

In `server/catgo/cli/session.py`, locate the `Session` dataclass and change:

```python
    link: object | None = None  # ServerLink placeholder (P3)
```

to:

```python
    link: "Optional[ServerLink]" = None  # populated at CLI entry (P3a)
```

At the top of the file, ensure the imports include (inside a `TYPE_CHECKING` guard so we don't introduce a runtime cycle):

```python
from typing import Optional, TYPE_CHECKING
if TYPE_CHECKING:
    from catgo.cli.server_link import ServerLink
```

- [ ] **Step 3: Verify**

Run: `cd server && python -m pytest tests/cli/ -q`
Expected: all pass (no behavior change).

- [ ] **Step 4: Commit**

```bash
git add server/catgo/cli/session.py
git commit -m "refactor(cli): tighten Session.link annotation to Optional[ServerLink]

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 11: Full suite + offline regression + checkpoint

**Files:** test only.

- [ ] **Step 1: Full suite**

Run: `cd /home/james0001/project/catgo-LRG/server && python -m pytest tests/cli/ -v`
Expected: ALL pass / SKIP, ZERO failures. Paste the final summary line + per-file counts.

- [ ] **Step 2: Offline regression — P1/P2 ops untouched by viewer infra**

```bash
cd /home/james0001/project/catgo-LRG/server
# Ensure no server: curl http://localhost:8000/ returns 000 (or stop a stray one).
python -c "from pymatgen.core import Lattice, Structure; Structure(Lattice.cubic(3.61), ['Cu'], [[0,0,0]]).to(filename='/tmp/cu_p3.vasp', fmt='poscar')"
python -m catgo --no-autostart supercell /tmp/cu_p3.vasp --scaling 2,2,2 -o /tmp/cu222_p3.vasp
python -m catgo --no-autostart inspect /tmp/cu_p3.vasp
```
Expected: both exit 0; supercell writes the file (`8 sites`); inspect prints composition / spacegroup / nn. No server spawn. Paste outputs.

- [ ] **Step 3: --no-autostart push fails cleanly without server**

```bash
python -m catgo --no-autostart push /tmp/cu_p3.vasp
echo "exit=$?"
```
Expected: exit 2, stderr contains `--no-autostart` and "unreachable" or "server", NO Python traceback. Paste output.

- [ ] **Step 4: --help shows all 14 subcommands + global flag**

```bash
python -m catgo --help
```
Expected: usage line lists `serve setup status stop slab supercell convert inspect dos band cohp freq push pull`; `--no-autostart` appears in options. Paste the usage line.

- [ ] **Step 5: Checkpoint commit**

```bash
cd /home/james0001/project/catgo-LRG
git commit -m "test(cli): P3a viewer-sync suite green; offline regression + --no-autostart verified

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>" --allow-empty
```

Cleanup: `/tmp/cu_p3.vasp`, `/tmp/cu222_p3.vasp` (optional).

## Notes
- Verification only; do NOT modify source/tests to coerce a pass.
- If P1/P2 ops accidentally regress (any failure outside the new viewer
  tests), STOP and report BLOCKED with the failing test + traceback.

---

## Self-Review

**Spec coverage:**
- §1 `ServerLink` (discover + push + pull) → Tasks 1/2/3. ✓
- §1 auto-start `spawn_daemon_and_wait` → Task 4. ✓
- §1 `Session.link` tightened annotation → Task 10. ✓
- §1 `_run_op`/`shell` discover-on-entry + hook → Tasks 8/9. ✓
- §2 `push` schema (file or session, --panel, error paths) → Tasks 5/7. ✓
- §2 `pull` schema (--panel, --format, -o, updates session) → Tasks 6/7. ✓
- §3 Error table (no server, --no-autostart, spawn failure, HTTP 4xx, network drop, no input) → Tasks 1–9 (clean OpError boundaries). ✓
- §3 Tests (server_link, autostart, ops_viewer, dual-form equivalence, --no-autostart, regression) → Tasks 1–11. ✓
- Stacking on P2 → header + branch creation. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands carry expected output; the fixture-less viewer integration test path is documented (CI never spawns real server). ✓

**Type consistency:** `ServerLink.discover()`/`push_structure(path, panel_id)`/`pull_structure(fmt, panel_id)` signatures consistent Tasks 1/2/3/5/6. `spawn_daemon_and_wait(timeout)->ServerLink` consistent Tasks 4/8/9. `Session.link: Optional[ServerLink]` consistent Tasks 5/6/8/9/10. `OpResult(ok,message,structure,artifact)` honored Tasks 5/6 (push: `structure=None`, `artifact=None`; pull: `structure=session.structure`, `artifact=Path(out)` if `-o`). `Param`/`Operation` registry usage consistent with P1/P2 Task 7. `--no-autostart` global flag uniformly named (`no_autostart` dest) across Tasks 8/9. ✓
