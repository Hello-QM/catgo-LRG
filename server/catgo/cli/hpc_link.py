"""Synchronous SSH/scp/sbatch driver for `catgo submit`.

Why stdlib subprocess instead of the FastAPI /hpc/* routes:

- Every /hpc/* endpoint requires a pre-connected session_id from
  `HPCConnectionPool`, which is created by either an interactive
  WebSocket auth flow or the `connect_ssh_config` REST route that
  itself shells out to `ssh <alias>` in subprocess mode. The
  connection is loop-bound (asyncssh `_owner_loop`) and expects to
  live for the duration of the process — heavyweight for one-shot
  submission from the CLI.
- Both auth modes we accept (SSH_CONFIG and KEY) eventually reduce to
  `ssh <args>` invocations. Doing that directly mirrors P3a's choice
  of stdlib `urllib.request` over `httpx` — no new dependency, no
  loop juggling, fully sync-friendly for the CLI handler shape.

Auth modes:
    SSH_CONFIG — uses `~/.ssh/config` alias; zero credentials needed
                 (ControlMaster handles persistent auth).
    KEY        — `-i <key_file>` + `-o BatchMode=yes` (failed key auth
                 errors out instead of prompting for a password).

PASSWORD / PASSWORD_OTP / KEY_OTP need stdin — rejected at construction
with a clean message pointing the user to ControlMaster setup or the
web UI.
"""
from __future__ import annotations

from dataclasses import dataclass

from catgo.models.hpc import AuthMethod, HPCProfile


class HpcError(Exception):
    """HPC submission failed (auth/ssh/scp/sbatch). Carries a user message."""


_HEADLESS_AUTH = (AuthMethod.SSH_CONFIG, AuthMethod.KEY)


@dataclass
class HpcLink:
    """Minimal sync driver for SSH_CONFIG / KEY profiles."""

    profile: HPCProfile
    timeout: int = 60

    def __post_init__(self) -> None:
        if self.profile.auth_method not in _HEADLESS_AUTH:
            raise HpcError(
                f"auth_method '{self.profile.auth_method.value}' needs "
                "interactive input; use ssh_config or key"
            )
