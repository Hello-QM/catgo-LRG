"""SSH file operation mixins for HPCConnection and LocalFileConnection.

These mixins use duck typing to access self.conn, self.is_subprocess_mode,
self.get_sftp(), self._sftp_failed, self.ssh_alias, and self.sftp.
No import of HPCConnection is needed.
"""

import asyncio
import logging
import posixpath
import shlex
import tarfile
import tempfile
from pathlib import Path
from typing import AsyncIterator

from catgo.models.hpc import FileInfo

logger = logging.getLogger(__name__)


class SSHFileOpsMixin:
    """File operation methods for HPCConnection (remote SSH)."""

    async def _run_clean_file_cmd(self, cmd: str, timeout: float = 20):
        """Run file-management commands without login-shell startup noise."""
        clean_cmd = f"bash --noprofile --norc -c {shlex.quote(cmd)}"
        runner = getattr(self.conn, "run_raw", None)
        if callable(runner):
            return await runner(clean_cmd, check=False, timeout=timeout)
        return await asyncio.wait_for(
            self.conn.run(clean_cmd, check=False),
            timeout=timeout,
        )

    async def _run_marked_file_cmd(self, cmd: str, timeout: float = 20) -> str:
        """Return only stdout emitted between CatGO markers."""
        begin = "__CATGO_FILE_BEGIN__"
        end = "__CATGO_FILE_END__"
        marked = (
            f"printf '%s\\n' {shlex.quote(begin)}; "
            f"{cmd}; "
            f"status=$?; "
            f"printf '\\n%s:%s\\n' {shlex.quote(end)} \"$status\"; "
            f"exit $status"
        )
        result = await self._run_clean_file_cmd(marked, timeout=timeout)
        stdout = result.stdout or ""
        start = stdout.find(begin)
        if start < 0:
            return stdout.strip()
        start += len(begin)
        tail = stdout[start:]
        end_pos = tail.rfind(end)
        if end_pos >= 0:
            tail = tail[:end_pos]
        return tail.strip("\r\n")

    async def _expand_remote_tilde(self, path: str) -> str:
        """Expand a leading tilde before passing paths to quoted shell commands."""
        if path == "~" or path.startswith("~/"):
            home = (await self._run_marked_file_cmd("printf %s \"$HOME\"", timeout=10)).strip()
            if not home:
                raise RuntimeError("Could not determine remote home directory")
            return path.replace("~", home, 1)
        return path

    async def list_remote_dir(self, path: str) -> tuple[str, list[FileInfo]]:
        """List files in a remote directory. Returns (resolved_path, files)."""
        if self.is_subprocess_mode:
            return await self._list_dir_subprocess(path)
        sftp = await self.get_sftp()
        if sftp is None:
            return await self._list_dir_subprocess(path)
        try:
            # Bound the op: realpath/readdir can hang on a DTN-offloaded node
            # even after the handshake succeeds. Timeout => fall back to exec.
            return await asyncio.wait_for(self._list_dir_sftp(path), timeout=15)
        except Exception as e:
            logger.warning(f"SFTP list_dir failed, falling back to exec: {e}")
            self._sftp_failed = True
            self.sftp = None
            return await self._list_dir_subprocess(path)

    async def _list_dir_sftp(self, path: str) -> tuple[str, list[FileInfo]]:
        sftp = await self.get_sftp()
        if path == "~" or path.startswith("~/"):
            home = await sftp.realpath(".")
            path = path.replace("~", home, 1)
        resolved = await sftp.realpath(path)
        entries = await sftp.readdir(resolved)
        files: list[FileInfo] = []
        for entry in entries:
            name = entry.filename
            if name in (".", ".."):
                continue
            attrs = entry.attrs
            files.append(FileInfo(
                name=name,
                path=f"{resolved}/{name}",
                is_dir=attrs.type == 2,
                size_bytes=attrs.size or 0,
                modified_time=str(attrs.mtime or ""),
            ))
        files.sort(key=lambda f: (not f.is_dir, f.name.lower()))
        return resolved, files

    async def _list_dir_subprocess(self, path: str) -> tuple[str, list[FileInfo]]:
        if path == "~" or path.startswith("~/"):
            home = (await self._run_marked_file_cmd("printf %s \"$HOME\"", timeout=10)).strip()
            path = path.replace("~", home, 1)
        resolved = (
            await self._run_marked_file_cmd(
                f"readlink -f -- {shlex.quote(path)} 2>/dev/null || printf %s {shlex.quote(path)}",
                timeout=10,
            )
        ).strip() or path
        # find format: type|size|mtime|name. Use maxdepth instead of shell globs
        # so huge directories and dotfiles do not expand inside the shell.
        cmd = (
            f"cd {shlex.quote(resolved)} && "
            "find . -mindepth 1 -maxdepth 1 "
            "-printf '%y|%s|%T@|%f\\n' 2>/dev/null | head -n 5000"
        )
        output = await self._run_marked_file_cmd(cmd, timeout=20)
        files: list[FileInfo] = []
        for line in output.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split("|", 3)
            if len(parts) < 4:
                continue
            ftype, size_str, mtime_str, name = parts
            if name in (".", ".."):
                continue
            files.append(FileInfo(
                name=name,
                path=f"{resolved}/{name}",
                is_dir=ftype == "d",
                size_bytes=int(size_str) if size_str.isdigit() else 0,
                modified_time=str(int(float(mtime_str))) if mtime_str else "",
            ))
        files.sort(key=lambda f: (not f.is_dir, f.name.lower()))
        return resolved, files

    async def upload_remote_file(self, content: bytes, remote_path: str) -> str:
        """Upload file content to remote path. Returns final remote path."""
        if self.is_subprocess_mode:
            return await self._upload_subprocess(content, remote_path)
        sftp = await self.get_sftp()
        if sftp is None:
            return await self._upload_exec(content, remote_path)
        try:
            return await self._upload_sftp(content, remote_path)
        except Exception as e:
            logger.warning(f"SFTP upload failed, falling back to exec: {e}")
            self._sftp_failed = True
            self.sftp = None
            return await self._upload_exec(content, remote_path)

    async def _upload_sftp(self, content: bytes, remote_path: str) -> str:
        sftp = await self.get_sftp()
        if remote_path == "~" or remote_path.startswith("~/"):
            home = await sftp.realpath(".")
            remote_path = remote_path.replace("~", home, 1)
        async with sftp.open(remote_path, "wb") as f:
            await f.write(content)
        return remote_path

    async def _upload_subprocess(self, content: bytes, remote_path: str) -> str:
        if remote_path == "~" or remote_path.startswith("~/"):
            home = (await self._run_marked_file_cmd("printf %s \"$HOME\"", timeout=10)).strip()
            remote_path = remote_path.replace("~", home, 1)
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "BatchMode=yes", self.ssh_alias, f"cat > {shlex.quote(remote_path)}",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(input=content), timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(f"Upload failed: {stderr.decode()}")
        return remote_path

    async def _upload_exec(self, content: bytes, remote_path: str) -> str:
        """Upload file via SSH exec channel (fallback when SFTP unavailable)."""
        if remote_path == "~" or remote_path.startswith("~/"):
            home = (await self._run_marked_file_cmd("printf %s \"$HOME\"", timeout=10)).strip()
            remote_path = remote_path.replace("~", home, 1)
        result = await self.conn.run(
            f"cat > {shlex.quote(remote_path)}",
            input=content, check=False,
        )
        if result.exit_status != 0:
            raise RuntimeError(f"Upload via exec failed: {result.stderr}")
        return remote_path

    async def download_remote_file(self, remote_path: str):
        """Download file from remote, yielding chunks. Returns an async generator.

        Falls back from SFTP to SSH exec channel if SFTP is unavailable or fails.
        """
        if self.is_subprocess_mode:
            async for chunk in self._download_subprocess(remote_path):
                yield chunk
            return

        # For interactive downloads, an exec channel starts much faster on some
        # HPC gateways than opening/using the SFTP subsystem. Only fall back to
        # SFTP if exec fails BEFORE emitting any bytes -- once we've yielded a
        # chunk to the client, restarting from offset 0 would duplicate data and
        # corrupt the download.
        emitted = False
        try:
            async for chunk in self._download_exec(remote_path):
                emitted = True
                yield chunk
        except Exception as e:
            if emitted:
                logger.error(f"Exec download failed mid-stream, cannot fall back: {e}")
                raise
            logger.warning(f"Exec download failed before any data, falling back to SFTP: {e}")
            sftp = await self.get_sftp()
            if sftp is None:
                raise
            async for chunk in self._download_sftp(remote_path):
                yield chunk

    async def is_remote_dir(self, remote_path: str) -> bool:
        """Return whether a remote path is a directory."""
        expanded = await self._expand_remote_tilde(remote_path)
        result = await self.conn.run(
            f"test -d {shlex.quote(expanded)}", check=False
        )
        return result.exit_status == 0

    async def download_remote_archive(self, remote_path: str):
        """Stream a selected remote directory as a gzip-compressed tar archive."""
        expanded = await self._expand_remote_tilde(remote_path)
        path = expanded.rstrip("/")
        parent = posixpath.dirname(path) or "."
        name = posixpath.basename(path)
        if not name:
            raise RuntimeError("Cannot archive the filesystem root")
        command = (
            f"tar -czf - -C {shlex.quote(parent)} -- {shlex.quote(name)}"
        )
        if self.is_subprocess_mode:
            async for chunk in self._download_archive_subprocess(command):
                yield chunk
            return
        async for chunk in self._download_archive_exec(command):
            yield chunk

    async def _download_archive_subprocess(self, command: str):
        """Stream an archive through an SSH config subprocess connection."""
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "BatchMode=yes", self.ssh_alias, command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            yield chunk
        await proc.wait()
        if proc.returncode != 0:
            stderr = await proc.stderr.read()
            raise RuntimeError(f"Archive download failed: {stderr.decode()}")

    async def _download_archive_exec(self, command: str):
        """Stream an archive through an AsyncSSH exec channel."""
        process = await self.conn.create_process(command, encoding=None)
        try:
            while True:
                chunk = await process.stdout.read(65536)
                if not chunk:
                    break
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8")
                yield chunk
            # Wait for the real exit status. Reading it after close() can return
            # None and silently swallow a tar failure (e.g. unreadable files).
            status = await process.wait()
        finally:
            process.close()
        if status is not None and status != 0:
            raise RuntimeError(f"Archive download failed (exit {status})")

    async def _download_sftp(self, remote_path: str):
        sftp = await self.get_sftp()
        async with sftp.open(remote_path, "rb") as f:
            while True:
                chunk = await f.read(65536)
                if not chunk:
                    break
                yield chunk

    async def _download_subprocess(self, remote_path: str):
        # gzip on the remote side and inflate the stream locally. Large text
        # volumetric files (CHGCAR/AECCAR/LOCPOT) compress heavily, cutting the
        # slow-link transfer several-fold; already-compressed files (.h5) still
        # transfer correctly, just without a size win. Requires `gzip` on the
        # remote (universal on HPC); a missing gzip surfaces via returncode != 0.
        import zlib
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "BatchMode=yes", self.ssh_alias, f"gzip -c {shlex.quote(remote_path)}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        decomp = zlib.decompressobj(16 + zlib.MAX_WBITS)  # 16 => expect gzip header
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            out = decomp.decompress(chunk)
            if out:
                yield out
        tail = decomp.flush()
        if tail:
            yield tail
        await proc.wait()
        if proc.returncode != 0:
            stderr = await proc.stderr.read()
            raise RuntimeError(f"Download failed: {stderr.decode()}")

    async def _download_exec(self, remote_path: str):
        """Download file via SSH exec channel (fallback when SFTP unavailable)."""
        process = await self.conn.create_process(
            f"cat {shlex.quote(remote_path)}", encoding=None
        )
        try:
            while True:
                chunk = await process.stdout.read(65536)
                if not chunk:
                    break
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8")
                yield chunk
        finally:
            process.close()
        status = process.exit_status
        if status and status != 0:
            raise RuntimeError(f"Download via exec failed (exit {status})")

    async def _download_to_local_exec(self, remote_path: str, local_path: str) -> None:
        """Download remote file to local path via SSH exec channel."""
        with open(local_path, "wb") as f:
            async for chunk in self._download_exec(remote_path):
                f.write(chunk)

    async def download_to_local(self, remote_path: str, local_path: str) -> None:
        """Download a remote file to a local path. Works for both SSH and subprocess modes."""
        if self.is_subprocess_mode:
            # gzip on the remote and inflate locally: large text files
            # (COHPCAR.lobster for COHP, CHGCAR, etc.) compress heavily, cutting
            # the slow-link transfer several-fold; already-compressed files
            # (vaspout.h5) still arrive correctly, just without a size win.
            import zlib
            proc = await asyncio.create_subprocess_exec(
                "ssh", "-o", "BatchMode=yes", self.ssh_alias, f"gzip -c {shlex.quote(remote_path)}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            decomp = zlib.decompressobj(16 + zlib.MAX_WBITS)  # 16 => expect gzip header
            with open(local_path, "wb") as f:
                while True:
                    chunk = await proc.stdout.read(65536)
                    if not chunk:
                        break
                    out = decomp.decompress(chunk)
                    if out:
                        f.write(out)
                tail = decomp.flush()
                if tail:
                    f.write(tail)
            await proc.wait()
            if proc.returncode != 0:
                stderr = await proc.stderr.read()
                raise RuntimeError(f"Download failed: {stderr.decode()}")
            return

        sftp = await self.get_sftp()
        if sftp is None:
            await self._download_to_local_exec(remote_path, local_path)
            return

        try:
            async with sftp.open(remote_path, "rb") as rf:
                with open(local_path, "wb") as lf:
                    while True:
                        chunk = await rf.read(65536)
                        if not chunk:
                            break
                        lf.write(chunk)
        except Exception as e:
            logger.warning(f"SFTP download_to_local failed, falling back to exec: {e}")
            self._sftp_failed = True
            self.sftp = None
            await self._download_to_local_exec(remote_path, local_path)

    async def _get_file_size_exec(self, remote_path: str) -> int:
        """Get file size via SSH exec channel (stat command)."""
        result = await self.conn.run(
            f"stat -c '%s' {shlex.quote(remote_path)}", check=False
        )
        return int(result.stdout.strip()) if result.stdout.strip().isdigit() else 0

    async def get_remote_file_size(self, remote_path: str) -> int:
        """Get size of a remote file."""
        if self.is_subprocess_mode:
            return await self._get_file_size_exec(remote_path)

        try:
            return await self._get_file_size_exec(remote_path)
        except Exception as e:
            logger.warning(f"Exec stat failed, falling back to SFTP: {e}")
        sftp = await self.get_sftp()
        if sftp is None:
            return 0

        try:
            attrs = await sftp.stat(remote_path)
            return attrs.size or 0
        except Exception as e:
            logger.warning(f"SFTP stat failed, falling back to exec: {e}")
            self._sftp_failed = True
            self.sftp = None
            return await self._get_file_size_exec(remote_path)


class LocalFileOpsMixin:
    """File operation overrides for LocalFileConnection (local filesystem)."""

    async def list_remote_dir(self, path: str) -> tuple[str, list[FileInfo]]:
        """List local directory using pathlib."""
        p = self._resolve_local_path(path)
        resolved = str(p)
        files: list[FileInfo] = []
        try:
            for entry in p.iterdir():
                try:
                    stat = entry.stat()
                    files.append(FileInfo(
                        name=entry.name,
                        path=str(entry),
                        is_dir=entry.is_dir(),
                        size_bytes=stat.st_size,
                        modified_time=str(int(stat.st_mtime)),
                    ))
                except (PermissionError, OSError):
                    continue
        except PermissionError:
            raise RuntimeError(f"Permission denied: {resolved}")
        files.sort(key=lambda f: (not f.is_dir, f.name.lower()))
        return resolved, files

    async def upload_remote_file(self, content: bytes, remote_path: str) -> str:
        """Write bytes to a local file."""
        p = self._resolve_local_path(remote_path)
        p.write_bytes(content)
        return str(p)

    async def download_remote_file(self, remote_path: str) -> AsyncIterator[bytes]:
        """Yield chunks from a local file."""
        p = self._resolve_local_path(remote_path)
        with open(p, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                yield chunk

    async def is_remote_dir(self, remote_path: str) -> bool:
        """Return whether a local path is a directory."""
        return self._resolve_local_path(remote_path).is_dir()

    async def download_remote_archive(self, remote_path: str) -> AsyncIterator[bytes]:
        """Stream a selected local directory as a gzip-compressed tar archive."""
        src = self._resolve_local_path(remote_path)
        if not src.is_dir():
            raise RuntimeError(f"Not a directory: {src}")

        def create_archive():
            archive = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024)
            with tarfile.open(fileobj=archive, mode="w:gz") as tar:
                tar.add(src, arcname=src.name)
            archive.seek(0)
            return archive

        archive = await asyncio.to_thread(create_archive)
        try:
            while True:
                chunk = archive.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            archive.close()

    async def download_to_local(self, remote_path: str, local_path: str) -> None:
        """Copy a local file."""
        import shutil
        src = self._resolve_local_path(remote_path)
        shutil.copyfile(str(src), local_path)

    async def get_remote_file_size(self, remote_path: str) -> int:
        p = self._resolve_local_path(remote_path)
        return p.stat().st_size
