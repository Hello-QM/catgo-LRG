"""SSH authentication helpers: SOCKS5 proxy tunnel and OTP-aware SSH client."""

import asyncio
import logging
import socket
import struct
from typing import Any, Callable, Coroutine, Optional

import asyncssh

logger = logging.getLogger(__name__)

OTPCallback = Callable[[str], Coroutine[Any, Any, str]]


# ====== SOCKS5 Proxy Tunnel ======


class Socks5Tunnel:
    """SOCKS5 proxy tunnel for asyncssh.

    Implements the create_connection() interface expected by asyncssh's `tunnel`
    parameter.  This allows SSH connections to be routed through a SOCKS5 proxy
    (e.g. ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:1080 %h %p').

    Uses raw socket operations for the SOCKS5 handshake to avoid Windows
    ProactorEventLoop's TransportSocket wrapper (which strips send/recv).

    Usage:
        tunnel = Socks5Tunnel("127.0.0.1", 1080)
        conn = await asyncssh.connect(host, tunnel=tunnel, ...)
    """

    def __init__(
        self,
        proxy_host: str,
        proxy_port: int = 1080,
        proxy_username: Optional[str] = None,
        proxy_password: Optional[str] = None,
    ):
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        self.proxy_username = proxy_username
        self.proxy_password = proxy_password

    @staticmethod
    async def _recvexactly(
        loop: asyncio.AbstractEventLoop,
        sock: socket.socket,
        n: int,
    ) -> bytes:
        """Receive exactly *n* bytes from a non-blocking socket."""
        buf = bytearray()
        while len(buf) < n:
            chunk = await loop.sock_recv(sock, n - len(buf))
            if not chunk:
                raise ConnectionError(
                    "[CatGo:SOCKS5] Proxy closed connection unexpectedly"
                )
            buf.extend(chunk)
        return bytes(buf)

    async def create_connection(
        self,
        session_factory: Any,
        host: str,
        port: int,
    ) -> tuple[Any, Any]:
        """Open a TCP socket through the SOCKS5 proxy, then hand it to asyncssh.

        SOCKS5 protocol (RFC 1928):
          1. Greeting: client → proxy  (supported auth methods)
          2. Auth:     client ↔ proxy  (username/password if needed)
          3. Connect:  client → proxy  (target host:port)
          4. Proxy opens TCP to target, then relays bytes bidirectionally.
        """
        logger.info(
            "[CatGo:SOCKS5] Opening SOCKS5 tunnel via %s:%d → %s:%d",
            self.proxy_host, self.proxy_port, host, port,
        )

        loop = asyncio.get_event_loop()

        # Step 1: TCP connect to the SOCKS5 proxy using a raw socket.
        # We avoid asyncio.open_connection() because on Windows the
        # ProactorEventLoop wraps the socket in a TransportSocket that
        # removes send/recv — which later breaks asyncssh.
        raw_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw_sock.setblocking(False)

        try:
            await loop.sock_connect(raw_sock, (self.proxy_host, self.proxy_port))

            # Step 2: SOCKS5 greeting — advertise supported auth methods
            has_auth = bool(self.proxy_username and self.proxy_password)
            if has_auth:
                # Support both no-auth (0x00) and username/password (0x02)
                await loop.sock_sendall(raw_sock, b"\x05\x02\x00\x02")
            else:
                # No-auth only
                await loop.sock_sendall(raw_sock, b"\x05\x01\x00")

            resp = await self._recvexactly(loop, raw_sock, 2)
            if resp[0] != 0x05:
                raise ConnectionError(
                    f"[CatGo:SOCKS5] Proxy returned invalid SOCKS version: {resp[0]}"
                )

            chosen_auth = resp[1]
            if chosen_auth == 0x02 and has_auth:
                # Username/password auth (RFC 1929)
                assert self.proxy_username is not None
                assert self.proxy_password is not None
                uname = self.proxy_username.encode()
                passwd = self.proxy_password.encode()
                await loop.sock_sendall(
                    raw_sock,
                    b"\x01"
                    + bytes([len(uname)]) + uname
                    + bytes([len(passwd)]) + passwd,
                )
                auth_resp = await self._recvexactly(loop, raw_sock, 2)
                if auth_resp[1] != 0x00:
                    raise ConnectionError(
                        "[CatGo:SOCKS5] Proxy authentication failed"
                    )
                logger.info("[CatGo:SOCKS5] Proxy auth succeeded (username/password)")
            elif chosen_auth == 0x00:
                logger.info("[CatGo:SOCKS5] Proxy auth: none required")
            elif chosen_auth == 0xFF:
                raise ConnectionError(
                    "[CatGo:SOCKS5] Proxy rejected all auth methods"
                )
            else:
                raise ConnectionError(
                    f"[CatGo:SOCKS5] Unsupported auth method from proxy: {chosen_auth:#x}"
                )

            # Step 3: CONNECT request — ask proxy to open TCP to target
            host_bytes = host.encode("ascii")
            port_bytes = struct.pack("!H", port)
            await loop.sock_sendall(
                raw_sock,
                b"\x05\x01\x00\x03"  # VER=5, CMD=CONNECT, RSV=0, ATYP=DOMAIN
                + bytes([len(host_bytes)]) + host_bytes
                + port_bytes,
            )

            # Read CONNECT response (at least 4 bytes header)
            connect_resp = await self._recvexactly(loop, raw_sock, 4)
            if connect_resp[1] != 0x00:
                error_codes = {
                    0x01: "general failure",
                    0x02: "connection not allowed",
                    0x03: "network unreachable",
                    0x04: "host unreachable",
                    0x05: "connection refused",
                    0x06: "TTL expired",
                    0x07: "command not supported",
                    0x08: "address type not supported",
                }
                err_msg = error_codes.get(connect_resp[1], f"unknown ({connect_resp[1]:#x})")
                raise ConnectionError(
                    f"[CatGo:SOCKS5] CONNECT failed: {err_msg}"
                )

            # Drain remaining bytes of the CONNECT response (bound address)
            atyp = connect_resp[3]
            if atyp == 0x01:  # IPv4
                await self._recvexactly(loop, raw_sock, 4 + 2)
            elif atyp == 0x03:  # Domain
                domain_len = (await self._recvexactly(loop, raw_sock, 1))[0]
                await self._recvexactly(loop, raw_sock, domain_len + 2)
            elif atyp == 0x04:  # IPv6
                await self._recvexactly(loop, raw_sock, 16 + 2)

            logger.info(
                "[CatGo:SOCKS5] Tunnel established: proxy %s:%d → %s:%d",
                self.proxy_host, self.proxy_port, host, port,
            )

            # Step 4: Hand the raw socket directly to asyncssh.
            # Because raw_sock is a plain socket.socket (not a TransportSocket
            # wrapper), asyncssh can call send/recv on it without issues.
            return await loop.create_connection(
                session_factory,
                sock=raw_sock,
            )

        except Exception:
            raw_sock.close()
            raise


# ====== OTP-aware SSH Client ======


class KbdintSSHClient(asyncssh.SSHClient):
    """SSH client that handles keyboard-interactive auth.

    Supports two modes:
    - Password only: auto-responds to all prompts with password
    - Password + OTP: responds to password prompts with password,
      everything else (OTP/DUO/verification) with the OTP code
    """

    def __init__(self, password: str, otp_code: Optional[str] = None) -> None:
        super().__init__()
        self._password = password
        self._otp_code = otp_code
        self._challenge_count = 0

    def connection_made(self, conn: asyncssh.SSHClientConnection) -> None:
        logger.info("SSH connection established")

    def connection_lost(self, exc: Optional[Exception]) -> None:
        if exc:
            logger.warning(f"SSH connection lost: {exc}")
        # Mark the associated HPCConnection as dead so get_connection() can clean up
        hpc_ref = getattr(self, '_hpc_ref', None)
        if hpc_ref is not None:
            hpc_ref._alive = False
            logger.info(f"Marked session {hpc_ref.session_id} as dead (connection_lost)")

    def kbdint_auth_requested(self) -> Optional[str]:
        return ""  # accept any submethods

    def kbdint_challenge_received(
        self,
        name: str,
        instructions: str,
        lang: str,
        prompts: list[tuple[str, bool]],
    ) -> Optional[list[str]]:
        """Handle keyboard-interactive challenges.

        Prompt classification order matters: OTP-specific keywords are checked
        BEFORE the generic "password" keyword because some servers (e.g. KAUST
        Shaheen) use prompts like "One-time password (OATH)" that contain
        "password" but actually expect the OTP code, not a login password.
        """
        self._challenge_count += 1
        responses: list[str] = []
        otp_keywords = ("one-time", "otp", "oath", "verification", "passcode",
                        "token", "duo", "2fa", "second factor", "authenticator")
        for prompt_text, _echo in prompts:
            lower = prompt_text.lower()
            if self._otp_code is not None and any(kw in lower for kw in otp_keywords):
                # OTP prompt (checked first — "one-time password" contains
                # "password" but should be answered with the OTP code)
                responses.append(self._otp_code)
                logger.info("[CatGo:HPC] kbdint prompt %r → sending OTP code", prompt_text)
            elif "password" in lower:
                responses.append(self._password)
                logger.info("[CatGo:HPC] kbdint prompt %r → sending password (len=%d)", prompt_text, len(self._password))
            elif self._otp_code is not None:
                # Unknown prompt with OTP available — assume it's OTP
                responses.append(self._otp_code)
                logger.info("[CatGo:HPC] kbdint prompt %r → sending OTP (unknown prompt)", prompt_text)
            else:
                # No OTP code available, try password as fallback
                responses.append(self._password)
                logger.info("[CatGo:HPC] kbdint prompt %r → sending password fallback (len=%d)", prompt_text, len(self._password))
        logger.info(
            "[CatGo:HPC] kbdint challenge #%d: name=%r, instructions=%r, "
            "%d prompt(s), otp=%s",
            self._challenge_count, name, instructions,
            len(prompts), "yes" if self._otp_code else "no",
        )
        return responses
