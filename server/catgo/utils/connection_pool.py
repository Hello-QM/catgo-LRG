"""HPC connection pool and profile persistence."""

import asyncio
import json
import logging
import os
import socket
import time
from pathlib import Path
from typing import Any, Optional

import asyncssh

from catgo.models.hpc import (
    AuthMethod,
    ConnectionInfo,
    HPCConnectionConfig,
    HPCProfile,
    SchedulerType,
)
from catgo.utils.hpc_connection import HPCConnection
from catgo.utils.hpc_client import LOCAL_SESSION_ID
from catgo.utils.local_connection import (
    LocalFileConnection,
    SubprocessSSHRunner,
)
from catgo.utils.ssh_auth import KbdintSSHClient, OTPCallback, Socks5Tunnel

logger = logging.getLogger(__name__)


def _persist_hpc_session(
    session_id: str, config: HPCConnectionConfig, username: str, host: str,
) -> None:
    """Save HPC session config to engine DB for auto-reconnect (non-fatal)."""
    # Only persist auth methods that can reconnect without user input
    if config.auth_method not in (AuthMethod.SSH_CONFIG, AuthMethod.KEY):
        return
    if config.auth_method == AuthMethod.KEY and not config.key_file:
        return  # Key auth without explicit key_file can't reliably reconnect
    try:
        from catgo.workflow.db import WorkflowDB
        db = WorkflowDB(os.path.expanduser("~/.catgo/catgo.db"))
        db.save_hpc_session(
            session_id=session_id,
            host=host,
            username=username,
            port=config.port,
            auth_method=config.auth_method.value,
            ssh_alias=config.ssh_alias,
            key_file=config.key_file,
            scheduler=config.scheduler.value,
        )
    except Exception:
        pass  # Non-fatal


def _delete_persisted_session(session_id: str) -> None:
    """Remove a persisted HPC session from engine DB (non-fatal)."""
    try:
        from catgo.workflow.db import WorkflowDB
        db = WorkflowDB(os.path.expanduser("~/.catgo/catgo.db"))
        db.delete_hpc_session(session_id)
    except Exception:
        pass  # Non-fatal


class HPCConnectionPool:
    """Manages SSH connections with reuse, keepalive, and idle cleanup."""

    IDLE_TIMEOUT = 3600  # 1 hour
    OTP_TIMEOUT = 120  # 2 minutes for user to enter OTP
    CLEANUP_INTERVAL = 120  # Check every 2 minutes (keep HPC firewalls from dropping idle TCP)

    def __init__(self) -> None:
        self.connections: dict[str, HPCConnection] = {}
        self._dead_connections: dict[str, HPCConnection] = {}  # Keeps metadata for auto-reconnect
        self._cleanup_task: Optional[asyncio.Task[None]] = None
        # Register always-available local filesystem connection
        self.connections[LOCAL_SESSION_ID] = LocalFileConnection()

    def start_cleanup(self) -> None:
        """Start background cleanup of idle connections."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self) -> None:
        """Periodically close idle connections and send keepalives."""
        while True:
            await asyncio.sleep(self.CLEANUP_INTERVAL)
            now = time.time()
            expired = [
                sid
                for sid, hpc in self.connections.items()
                if sid != LOCAL_SESSION_ID and now - hpc.last_used > self.IDLE_TIMEOUT
            ]
            for sid in expired:
                logger.info(f"Closing idle connection: {sid}")
                await self.disconnect(sid)

            # Send keepalive pings to ALL remote connections.
            # Application-level pings (not just SSH protocol keepalives) are
            # needed to reset firewall/NAT idle timers on the TCP session.
            # Without these, long-running jobs (NEB-TS, IRC) lose their
            # connection after the firewall's idle timeout (typically 10-20 min).
            for sid, hpc in list(self.connections.items()):
                if sid == LOCAL_SESSION_ID:
                    continue
                try:
                    result = await asyncio.wait_for(
                        hpc.conn.run("echo __catgo_keepalive__", check=False),
                        timeout=15,
                    )
                    if "__catgo_keepalive__" not in (result.stdout or ""):
                        logger.warning(f"Keepalive failed for {sid}, marking dead")
                        hpc._alive = False
                except Exception as exc:
                    logger.warning(f"Keepalive error for {sid}: {exc}, marking dead")
                    hpc._alive = False

    async def connect(
        self,
        config: HPCConnectionConfig,
        session_id: str,
        otp_callback: Optional[OTPCallback] = None,
    ) -> HPCConnection:
        """
        Establish SSH connection, optionally through a SOCKS5 proxy and/or jump host.

        Connection chain (each layer is optional):
            [SOCKS5 proxy] → [Jump host] → Target host

        Args:
            config: Connection configuration (includes proxy_host for SOCKS5)
            session_id: Unique session identifier
            otp_callback: Async callback that receives the OTP prompt and returns the code

        Returns:
            HPCConnection added to the pool
        """
        self.start_cleanup()

        jump_conn: Optional[asyncssh.SSHClientConnection] = None
        tunnel: Any = None

        try:
            # Strip whitespace from user inputs
            config.host = config.host.strip()
            if config.username:
                config.username = config.username.strip()

            # Debug: log full config for SOCKS5 troubleshooting
            logger.info(
                "[CatGo:HPC] connect() called: host='%s', proxy_host='%s', proxy_port=%s, auth=%s",
                config.host, config.proxy_host, config.proxy_port, config.auth_method,
            )

            # Step 0: Set up SOCKS5 proxy tunnel if configured
            # Strip whitespace from proxy_host (UI input fields can have trailing spaces)
            if config.proxy_host:
                config.proxy_host = config.proxy_host.strip()
            if config.proxy_host:
                proxy_pw = config.proxy_password.get_secret_value() if config.proxy_password else None
                logger.info(
                    "[CatGo:HPC] Using SOCKS5 proxy %s:%d (auth=%s)",
                    config.proxy_host, config.proxy_port,
                    "yes" if config.proxy_username else "no",
                )
                tunnel = Socks5Tunnel(
                    proxy_host=config.proxy_host,
                    proxy_port=config.proxy_port,
                    proxy_username=config.proxy_username,
                    proxy_password=proxy_pw,
                )

            # Step 1: Connect to jump host if configured
            # When both SOCKS5 proxy and jump host are used, the chain is:
            #   SOCKS5 → Jump Host → Target Host
            if config.jump_host:
                jump_username = config.jump_username or config.username
                logger.info(
                    "[CatGo:HPC] Connecting to jump host %s:%d%s",
                    config.jump_host, config.jump_port,
                    " (via SOCKS5 proxy)" if tunnel else "",
                )

                # Common kwargs — include SOCKS5 tunnel if present
                jump_kwargs: dict[str, Any] = {
                    "host": config.jump_host,
                    "port": config.jump_port,
                    "username": jump_username,
                    "known_hosts": None,
                    "keepalive_interval": 30,
                }
                if tunnel:
                    jump_kwargs["tunnel"] = tunnel

                if config.jump_password:
                    # Jump host has its own password → use kbdint
                    jp = config.jump_password.get_secret_value()

                    def jump_client_factory() -> KbdintSSHClient:
                        return KbdintSSHClient(password=jp)

                    jump_kwargs["client_factory"] = jump_client_factory
                    jump_kwargs["preferred_auth"] = "keyboard-interactive,password"
                    jump_conn = await asyncssh.connect(**jump_kwargs)
                else:
                    # No jump password → use SSH key auth
                    default_keys = [
                        str(Path.home() / ".ssh" / "id_rsa"),
                        str(Path.home() / ".ssh" / "id_ed25519"),
                        str(Path.home() / ".ssh" / "id_ecdsa"),
                    ]
                    client_keys = [k for k in default_keys if Path(k).exists()]
                    logger.info(f"[CatGo:HPC] Jump host key auth with {len(client_keys)} key(s)")
                    jump_kwargs["client_keys"] = client_keys
                    jump_conn = await asyncssh.connect(**jump_kwargs)
                tunnel = jump_conn

            # Step 2: Connect to target host
            logger.info(
                "[CatGo:HPC] Connecting to %s:%d (auth=%s, proxy=%s, jump=%s)",
                config.host, config.port, config.auth_method.value,
                config.proxy_host or "none",
                config.jump_host or "none",
            )
            password = config.password.get_secret_value() if config.password else None

            # Determine SSH keys and auth methods to avoid "Too many auth failures".
            # Only try publickey when we have a specific key or auth_method requires it.
            connect_kwargs: dict[str, Any] = {
                "host": config.host,
                "port": config.port,
                "username": config.username,
                "known_hosts": None,
                "tunnel": tunnel,
                "keepalive_interval": 30,
            }

            is_password_auth = config.auth_method in (AuthMethod.PASSWORD, AuthMethod.PASSWORD_OTP)

            if is_password_auth:
                # Password-based auth → skip publickey entirely (even if key_file is set)
                # This prevents "Too many auth failures" from trying wrong/unwanted keys.
                # IMPORTANT: password BEFORE keyboard-interactive because many HPC
                # servers (e.g. KAUST Shaheen) require SSH "password" auth first,
                # then "keyboard-interactive" for OTP as a second factor.
                connect_kwargs["client_keys"] = []
                preferred_auth = "password,keyboard-interactive"
                logger.info("[CatGo:HPC] Password auth: skipping publickey")
            elif config.key_file:
                # Key-based auth with explicit key file
                expanded = str(Path(config.key_file).expanduser())
                if not Path(expanded).exists():
                    raise ValueError(f"Key file not found: {config.key_file}")
                connect_kwargs["client_keys"] = [expanded]
                connect_kwargs["agent_forwarding"] = False
                connect_kwargs["agent_path"] = None  # Disable SSH agent to prevent extra key attempts
                preferred_auth = "publickey,keyboard-interactive"
                logger.info(f"[CatGo:HPC] Using explicit key: {expanded}")
            elif config.auth_method in (AuthMethod.KEY, AuthMethod.KEY_OTP):
                # Key-based auth without explicit key → let asyncssh use agent + defaults
                preferred_auth = "publickey,keyboard-interactive,password"
                logger.info("[CatGo:HPC] Key auth: using SSH agent / default key discovery")
            else:
                # Fallback — try password first (more commonly supported)
                connect_kwargs["client_keys"] = []
                preferred_auth = "password,keyboard-interactive"
                logger.info("[CatGo:HPC] Default auth: password,keyboard-interactive")

            connect_kwargs["preferred_auth"] = preferred_auth

            # Pass password to asyncssh for the SSH "password" auth method.
            # This is separate from keyboard-interactive — many HPC servers
            # (e.g. KAUST Shaheen) require password auth first, then kbdint OTP.
            if password:
                connect_kwargs["password"] = password

            logger.info(
                "[CatGo:HPC] DEBUG auth_method=%s, has_password=%s, has_key_file=%s, "
                "preferred_auth=%s, client_keys=%s",
                config.auth_method.value,
                bool(password),
                bool(config.key_file),
                preferred_auth,
                connect_kwargs.get("client_keys", "not set"),
            )

            needs_otp = config.auth_method in (AuthMethod.PASSWORD_OTP, AuthMethod.KEY_OTP)

            if needs_otp and otp_callback:
                # OTP required: ask user for code, then connect.
                # The OTP prompt arrives AFTER password auth succeeds,
                # in the keyboard-interactive phase.
                otp_code = await asyncio.wait_for(
                    otp_callback("Enter verification code:"),
                    timeout=self.OTP_TIMEOUT,
                )

                def otp_client_factory() -> KbdintSSHClient:
                    return KbdintSSHClient(
                        password=password or "",
                        otp_code=otp_code,
                    )

                connect_kwargs["client_factory"] = otp_client_factory
                conn = await asyncssh.connect(**connect_kwargs)

            elif password:
                # Password only (no OTP) — still need client_factory for
                # connection_lost callback and any kbdint fallback
                def pwd_client_factory() -> KbdintSSHClient:
                    return KbdintSSHClient(password=password)  # type: ignore[arg-type]

                connect_kwargs["client_factory"] = pwd_client_factory
                conn = await asyncssh.connect(**connect_kwargs)

            else:
                # Key only (no password, no OTP)
                # Still use client_factory so get_owner() returns our client
                # and connection_lost can mark the HPCConnection as dead.
                def key_client_factory() -> KbdintSSHClient:
                    return KbdintSSHClient(password="")

                connect_kwargs["client_factory"] = key_client_factory
                conn = await asyncssh.connect(**connect_kwargs)

            hpc = HPCConnection(
                session_id=session_id,
                conn=conn,
                jump_conn=jump_conn,
                config=config,
                scheduler_type=config.scheduler,
                username=config.username,
                host=config.host,
                _owner_loop=asyncio.get_running_loop(),
            )
            # Link SSH client back to HPCConnection so connection_lost can mark it dead
            owner = conn.get_owner()
            if owner is not None:
                owner._hpc_ref = hpc
            else:
                logger.warning("[CatGo:HPC] Could not link connection_lost callback for %s", session_id)
            self.connections[session_id] = hpc
            logger.info("[CatGo:HPC] Connected to %s (session=%s)", config.host, session_id)
            _persist_hpc_session(session_id, config, config.username, config.host)
            return hpc

        except Exception as exc:
            # Clean up jump connection on failure
            logger.error("[CatGo:HPC] Connection to %s failed: %s", config.host, exc)
            logger.error(
                "[CatGo:HPC]   auth=%s, proxy=%s, jump=%s",
                config.auth_method.value, config.proxy_host or "none", config.jump_host or "none",
            )
            if jump_conn:
                jump_conn.close()
            # Provide helpful hints for common errors
            msg = str(exc)
            if "too many authentication" in msg.lower():
                hint = (
                    f"{msg}. Hint: specify the exact key_file for this host "
                    f"(e.g. ~/.ssh/id_rsa_myhost) to avoid trying wrong keys."
                )
                raise ConnectionError(hint) from exc
            if "getaddrinfo" in msg.lower():
                # DNS resolution failed — identify which host
                failed_host = config.host
                all_resolved = True
                for test_host in [config.proxy_host, config.jump_host, config.host]:
                    if not test_host:
                        continue
                    try:
                        socket.getaddrinfo(test_host, 22)
                    except socket.gaierror:
                        failed_host = test_host
                        all_resolved = False
                        break
                if all_resolved:
                    hint = (
                        f"Connection to '{config.host}' failed (original: {type(exc).__name__}: {msg}). "
                        f"DNS resolves OK locally — this may be a transient issue. Please retry."
                    )
                else:
                    hint = (
                        f"DNS resolution failed for '{failed_host}'. "
                        f"Check that the hostname is correct and your network/VPN can reach it."
                    )
                raise ConnectionError(hint) from exc
            raise

    async def connect_ssh_config(
        self,
        config: HPCConnectionConfig,
        session_id: str,
    ) -> HPCConnection:
        """Connect using system ssh binary (ControlMaster mode)."""
        self.start_cleanup()

        alias = config.ssh_alias or config.host
        runner = SubprocessSSHRunner(alias)

        # Verify connectivity
        try:
            result = await asyncio.wait_for(
                runner.run("echo __catgo_ok__", check=False),
                timeout=15,
            )
            if result.exit_status != 0 or "__catgo_ok__" not in (result.stdout or ""):
                raise ConnectionError(
                    f"SSH config connection failed: {result.stderr or 'no output'}"
                )
        except asyncio.TimeoutError:
            raise ConnectionError(
                f"SSH config connection timed out. Is ControlMaster active for '{alias}'?"
            )

        # Get remote username
        whoami_result = await runner.run("whoami", check=False)
        remote_username = (whoami_result.stdout or "").strip() or config.username

        # Get hostname
        hostname_result = await runner.run("hostname -f 2>/dev/null || hostname", check=False)
        remote_host = (hostname_result.stdout or "").strip() or config.host or alias

        hpc = HPCConnection(
            session_id=session_id,
            conn=runner,
            config=config,
            scheduler_type=config.scheduler,
            username=remote_username,
            host=remote_host,
            ssh_alias=alias,
            _owner_loop=asyncio.get_running_loop(),
        )
        self.connections[session_id] = hpc
        logger.info(f"Connected via SSH config to '{alias}' as {remote_username} (session: {session_id})")
        _persist_hpc_session(session_id, config, remote_username, remote_host)
        return hpc

    def get_connection(self, session_id: str) -> Optional[HPCConnection]:
        """Get an existing connection, updating last_used timestamp.

        Accepts either a UUID session_id or a 'user@host' format string.
        If the connection has been detected as dead (via asyncssh
        connection_lost callback or transport state), it is removed
        from the pool and None is returned.
        """
        hpc = self.connections.get(session_id)

        # Fallback: if session_id looks like 'user@host', search by matching host/username
        if not hpc and "@" in session_id:
            for sid, conn in self.connections.items():
                user_host = f"{conn.username}@{conn.host}"
                if user_host == session_id and conn.is_alive:
                    logger.info(f"Resolved '{session_id}' to session {sid}")
                    hpc = conn
                    break

        if hpc and not hpc.is_alive:
            logger.info(f"Removing dead connection: {session_id} ({hpc.username}@{hpc.host})")
            self.connections.pop(session_id, None)
            # Preserve metadata for auto-reconnect (only if we have a config)
            if hpc.config:
                self._dead_connections[session_id] = hpc
            return None
        if hpc:
            hpc.last_used = time.time()
        return hpc

    async def get_connection_for_step(
        self,
        session_id: str | None,
        hpc_host: str | None = None,
    ) -> Optional["HPCConnection"]:
        """Get an HPC connection for a workflow step, with fallback.

        Tries in order:
        1. Exact session_id match
        2. Auto-reconnect dead session
        3. Any session matching hpc_host (user@host)
        4. Any active remote session

        This handles the common case where the user reconnects to the
        same cluster but gets a new session_id.
        """
        # 1. Exact match
        if session_id:
            hpc = self.get_connection(session_id)
            if hpc:
                return hpc
            # 2. Try auto-reconnect
            try:
                hpc = await self.try_reconnect(session_id)
            except Exception:
                hpc = None
            if hpc:
                return hpc

        # Collect live remote connections
        remote = [
            hpc for sid, hpc in self.connections.items()
            if sid != LOCAL_SESSION_ID and hpc.is_alive
        ]
        logger.debug(
            "get_connection_for_step: session_id=%s hpc_host=%s remote_count=%d remote_hosts=%s",
            session_id, hpc_host, len(remote),
            [f"{h.username}@{h.host}" for h in remote],
        )

        # 2. Match by host
        if hpc_host and remote:
            for hpc in remote:
                if f"{hpc.username}@{hpc.host}" == hpc_host:
                    return hpc

        # 3. Use any available remote session
        if remote:
            return remote[0]

        return None

    async def try_reconnect(self, session_id: str) -> Optional[HPCConnection]:
        """Try to reconnect a dead session using stored config.

        Works for SSH_CONFIG mode (no password needed) and KEY auth
        (key file on disk). Returns the new connection with the SAME
        session_id, or None if reconnection is not possible.

        Reconnection is always performed on the FastAPI loop when
        available, so the new asyncssh connection's owner loop matches
        the loop that originally created sessions. This keeps every
        active connection owner-consistent and avoids the cross-event-
        loop Future bug when engine code later awaits against it.
        """
        dead = self._dead_connections.get(session_id)
        if not dead or not dead.config:
            return None

        config = dead.config
        auth = config.auth_method

        # Determine whether we need to hop to the FastAPI loop for the
        # reconnect. If the caller is already on that loop (or no
        # FastAPI loop is registered yet, e.g. during test setup),
        # the reconnect runs inline.
        from catgo.utils.hpc_client import get_fastapi_loop
        fastapi_loop = get_fastapi_loop()
        current_loop = asyncio.get_running_loop()
        needs_hop = (
            fastapi_loop is not None
            and fastapi_loop is not current_loop
            and not fastapi_loop.is_closed()
        )

        async def _do_ssh_config_reconnect() -> Optional[HPCConnection]:
            logger.info(
                "[CatGo:HPC] Auto-reconnecting SSH_CONFIG session %s (%s)",
                session_id, config.ssh_alias or config.host,
            )
            return await self.connect_ssh_config(config, session_id)

        async def _do_key_reconnect() -> Optional[HPCConnection]:
            logger.info(
                "[CatGo:HPC] Auto-reconnecting KEY session %s (%s@%s)",
                session_id, config.username, config.host,
            )
            return await self.connect(config, session_id)

        async def _dispatch(factory):
            if needs_hop:
                fut = asyncio.run_coroutine_threadsafe(factory(), fastapi_loop)
                return await asyncio.wrap_future(fut)
            return await factory()

        # Only auto-reconnect modes that don't require interactive input
        if auth == AuthMethod.SSH_CONFIG:
            try:
                hpc = await _dispatch(_do_ssh_config_reconnect)
                self._dead_connections.pop(session_id, None)
                logger.info("[CatGo:HPC] Auto-reconnect succeeded for %s", session_id)
                return hpc
            except Exception as exc:
                logger.warning("[CatGo:HPC] Auto-reconnect failed for %s: %s", session_id, exc)
                return None

        elif auth == AuthMethod.KEY and config.key_file:
            try:
                hpc = await _dispatch(_do_key_reconnect)
                self._dead_connections.pop(session_id, None)
                logger.info("[CatGo:HPC] Auto-reconnect succeeded for %s", session_id)
                return hpc
            except Exception as exc:
                logger.warning("[CatGo:HPC] Auto-reconnect failed for %s: %s", session_id, exc)
                return None

        else:
            # PASSWORD, PASSWORD_OTP, KEY_OTP all need interactive input
            logger.debug(
                "[CatGo:HPC] Cannot auto-reconnect %s (auth=%s requires user input)",
                session_id, auth.value,
            )
            return None

    def is_connected(self, session_id: str) -> bool:
        """Check if a session has an active connection."""
        return self.get_connection(session_id) is not None

    def list_connections(self) -> list[ConnectionInfo]:
        """List all active connections (including local).

        Dead connections are cleaned up before listing.
        """
        now = time.time()
        # Clean up dead connections first
        dead_sids = [
            sid for sid, hpc in self.connections.items()
            if sid != LOCAL_SESSION_ID and not hpc.is_alive
        ]
        for sid in dead_sids:
            hpc = self.connections.pop(sid, None)
            if hpc and hpc.config:
                self._dead_connections[sid] = hpc
            logger.info(f"Removing dead connection during list: {sid}")

        return [
            ConnectionInfo(
                session_id=hpc.session_id,
                host=hpc.host,
                username=hpc.username,
                scheduler=hpc.scheduler_type,
                uptime_seconds=now - hpc.connected_at,
                work_root=(hpc.config.work_root or "") if hpc.config else "",
            )
            for hpc in self.connections.values()
        ]

    async def disconnect(self, session_id: str) -> bool:
        """Close and remove a connection."""
        if session_id == LOCAL_SESSION_ID:
            return False  # Cannot disconnect local
        hpc = self.connections.pop(session_id, None)
        if hpc:
            await hpc.close()
            _delete_persisted_session(session_id)
            self._dead_connections.pop(session_id, None)
            logger.info(f"Disconnected session: {session_id}")
            return True
        return False

    async def shutdown(self) -> None:
        """Close all connections (called on server shutdown)."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
        for sid in list(self.connections.keys()):
            await self.disconnect(sid)


# ====== Profile Persistence ======

PROFILES_DIR = Path.home() / ".catgo"
PROFILES_FILE = PROFILES_DIR / "hpc_profiles.json"


def _load_profiles_raw() -> list[dict[str, Any]]:
    """Load raw profile data from disk."""
    if not PROFILES_FILE.exists():
        return []
    try:
        data = json.loads(PROFILES_FILE.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save_profiles_raw(profiles: list[dict[str, Any]]) -> None:
    """Save raw profile data to disk."""
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    PROFILES_FILE.write_text(json.dumps(profiles, indent=2))


def load_profiles() -> list[HPCProfile]:
    """Load saved HPC profiles."""
    raw = _load_profiles_raw()
    profiles: list[HPCProfile] = []
    for item in raw:
        try:
            profiles.append(HPCProfile(**item))
        except Exception as e:
            logger.debug("Skipping malformed HPC profile: %s", e)
            continue
    return profiles


def save_profile(profile: HPCProfile) -> None:
    """Save or update an HPC profile (upsert by name)."""
    raw = _load_profiles_raw()
    # Remove existing profile with same name
    raw = [p for p in raw if p.get("name") != profile.name]
    raw.append(profile.model_dump())
    _save_profiles_raw(raw)


def delete_profile(name: str) -> bool:
    """Delete a saved profile by name. Returns True if found and deleted."""
    raw = _load_profiles_raw()
    new_raw = [p for p in raw if p.get("name") != name]
    if len(new_raw) == len(raw):
        return False
    _save_profiles_raw(new_raw)
    return True


# ====== Singleton Pool ======

pool = HPCConnectionPool()
