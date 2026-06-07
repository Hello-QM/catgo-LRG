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


def _q_filename(name: str) -> str:
    """Quote a filename for the RFC 7578 multipart Content-Disposition
    quoted-string form: backslash and double-quote must be escaped."""
    return name.replace("\\", "\\\\").replace('"', '\\"')


@dataclass
class ServerLink:
    base_url: str

    @classmethod
    def discover(cls) -> "ServerLink | None":
        # Honor CATGO_API (the var `catgo setup` writes): when set, target ONLY
        # that endpoint and do NOT fall back to the local-port scan. This lets a
        # user point catgo at a specific server (remote tunnel / custom port) and
        # lets tests force a deterministic "no server" by pointing it at a dead
        # port — otherwise discovery depends on whatever happens to run on :8000.
        import os
        api = os.environ.get("CATGO_API")
        if api:
            base = api.rstrip("/")
            if base.endswith("/api"):
                base = base[: -len("/api")]
            return cls(base_url=base) if _ping(f"{base}/health") else None
        for port in (8000, 33413):
            url = f"http://localhost:{port}"
            if _ping(f"{url}/health"):
                return cls(base_url=url)
        return None

    def push_structure(self, path, panel_id) -> dict:
        """POST /api/view/upload-and-load (multipart). Returns server JSON."""
        import os
        from pathlib import Path
        p = Path(path)
        boundary = "----catgo-cli-" + os.urandom(8).hex()
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; '
            f'filename="{_q_filename(p.name)}"\r\n'
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
