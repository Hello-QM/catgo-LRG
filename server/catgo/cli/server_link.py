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
