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

import os
import re
import shlex
import subprocess
import tempfile
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

    # ---------- argv builders ----------

    def _ssh_target(self) -> list[str]:
        """Common ssh prefix excluding the remote command.

        SSH_CONFIG: just the alias.
        KEY:        `-i <key> -p <port> <user>@<host>`.
        Both modes add `-o BatchMode=yes` so a key/auth failure errors
        immediately instead of falling through to a password prompt.
        """
        p = self.profile
        out: list[str] = ["-o", "BatchMode=yes"]
        if p.auth_method == AuthMethod.SSH_CONFIG:
            alias = p.ssh_alias or p.host
            out.append(alias)
            return out
        # KEY
        if p.key_file:
            out.extend(["-i", p.key_file])
        out.extend(["-p", str(p.port)])
        out.append(f"{p.username}@{p.host}")
        return out

    def _ssh_argv(self, remote_cmd: str) -> list[str]:
        """argv for `ssh … 'bash -l -c <quoted-cmd>'`.

        bash -l matches the SubprocessSSHRunner / hpc.py convention so
        module-managed tools (sbatch, squeue, vasp_std, cp2k.psmp) are
        in PATH on the remote.
        """
        login_cmd = f"bash -l -c {shlex.quote(remote_cmd)}"
        return ["ssh", *self._ssh_target(), login_cmd]

    def _scp_argv(self, local_path: str, remote_path: str) -> list[str]:
        """argv for `scp -o BatchMode=yes [-i key] [-P port] <local> <target>:<remote>`.

        scp uses `-P` (capital) for port, unlike ssh's `-p`.
        """
        p = self.profile
        out: list[str] = ["scp", "-o", "BatchMode=yes"]
        if p.auth_method == AuthMethod.SSH_CONFIG:
            alias = p.ssh_alias or p.host
            target = f"{alias}:{remote_path}"
        else:
            if p.key_file:
                out.extend(["-i", p.key_file])
            out.extend(["-P", str(p.port)])
            target = f"{p.username}@{p.host}:{remote_path}"
        out.extend([local_path, target])
        return out

    # ---------- subprocess runner ----------

    def _run(self, argv: list[str], op_label: str) -> tuple[int, str, str]:
        """Run argv with capture+timeout. Returns (rc, stdout, stderr).

        On TimeoutExpired raises HpcError("<op_label> to <name>: timed out
        after <s>s"). The caller (preflight, mkdir_p, …) decides whether
        a nonzero rc is fatal so it can shape the error message in the
        domain it knows about.
        """
        try:
            cp = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise HpcError(
                f"{op_label} to {self.profile.name}: timed out after "
                f"{self.timeout}s"
            )
        return cp.returncode, cp.stdout or "", cp.stderr or ""

    def _first_stderr_line(self, stderr: str) -> str:
        for line in stderr.splitlines():
            if line.strip():
                return line.strip()
        return stderr.strip() or "(no stderr)"

    # ---------- public ops ----------

    def preflight(self) -> str:
        """Verify ssh connectivity and return the remote $HOME."""
        rc, out, err = self._run(self._ssh_argv("echo $HOME"), "ssh")
        if rc != 0:
            raise HpcError(
                f"ssh to {self.profile.name}: {self._first_stderr_line(err)}"
            )
        home = out.strip()
        if not home:
            raise HpcError(
                f"ssh to {self.profile.name}: empty $HOME from remote"
            )
        return home

    def mkdir_p(self, remote_dir: str) -> None:
        """Run `mkdir -p <remote_dir>` on the remote host."""
        cmd = f"mkdir -p {shlex.quote(remote_dir)}"
        rc, _, err = self._run(self._ssh_argv(cmd), "ssh")
        if rc != 0:
            raise HpcError(
                f"mkdir on {self.profile.name}: "
                f"{self._first_stderr_line(err)}"
            )

    def put_text(self, content: str, remote_path: str) -> None:
        """Stage `content` to a local tempfile and scp it to `remote_path`.

        Tempfile is unlinked unconditionally in a finally clause so a
        failed scp doesn't leave debris in the user's tmpdir.
        """
        # delete=False so we can close + scp + unlink ourselves; binary
        # mode + utf-8 keeps line endings byte-faithful to what the
        # caller passed (matters for INCAR/POSCAR formatting).
        tmp = tempfile.NamedTemporaryFile(
            mode="wb", suffix=".catgo-stage", delete=False
        )
        try:
            tmp.write(content.encode("utf-8"))
            tmp.close()
            rc, _, err = self._run(
                self._scp_argv(tmp.name, remote_path), "scp"
            )
            if rc != 0:
                raise HpcError(
                    f"scp to {self.profile.name}:{remote_path}: "
                    f"{self._first_stderr_line(err)}"
                )
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    def sbatch(self, remote_dir: str, script_name: str) -> str:
        """Run `cd <remote_dir> && sbatch <script>` and return job id.

        Mirrors `hpc.py:resubmit_job_endpoint`: parse the LAST `(\\d+)`
        match in stdout — SLURM's "Submitted batch job 12345" puts the
        id at the end, and `re.search` would also pick up any leading
        diagnostic number. Falling back to `findall(...)[-1]` is the
        robust choice.
        """
        cmd = (
            f"cd {shlex.quote(remote_dir)} && "
            f"sbatch {shlex.quote(script_name)}"
        )
        rc, out, err = self._run(self._ssh_argv(cmd), "sbatch")
        if rc != 0:
            raise HpcError(
                f"sbatch on {self.profile.name}: "
                f"{self._first_stderr_line(err)}"
            )
        ids = re.findall(r"(\d+)", out or "")
        if not ids:
            raise HpcError(
                f"sbatch on {self.profile.name}: could not parse job id "
                f"from '{(out or '').strip()}'"
            )
        return ids[-1]
