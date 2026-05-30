"""SSH file operation mixins for HPCConnection and LocalFileConnection.

These mixins use duck typing to access self.conn, self.is_subprocess_mode,
self.get_sftp(), self._sftp_failed, self.ssh_alias, and self.sftp.
No import of HPCConnection is needed.
"""

import asyncio
import logging
import shlex
from pathlib import Path
from typing import AsyncIterator

from catgo.models.hpc import FileInfo

logger = logging.getLogger(__name__)


class SSHFileOpsMixin:
    """File operation methods for HPCConnection (remote SSH)."""

    async def list_remote_dir(self, path: str) -> tuple[str, list[FileInfo]]:
        """List files in a remote directory. Returns (resolved_path, files)."""
        if self.is_subprocess_mode:
            return await self._list_dir_subprocess(path)
        sftp = await self.get_sftp()
        if sftp is None:
            return await self._list_dir_subprocess(path)
        try:
            return await self._list_dir_sftp(path)
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
            result = await self.conn.run("echo $HOME", check=False)
            home = result.stdout.strip()
            path = path.replace("~", home, 1)
        result = await self.conn.run(f"readlink -f {shlex.quote(path)}", check=False)
        resolved = result.stdout.strip() or path
        # stat -c format: type|size|mtime|name
        cmd = (
            f"cd {shlex.quote(resolved)} && "
            f"stat -c '%F|%s|%Y|%n' * .* 2>/dev/null || true"
        )
        result = await self.conn.run(cmd, check=False)
        files: list[FileInfo] = []
        for line in (result.stdout or "").strip().split("\n"):
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
                is_dir="directory" in ftype.lower(),
                size_bytes=int(size_str) if size_str.isdigit() else 0,
                modified_time=mtime_str,
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
            result = await self.conn.run("echo $HOME", check=False)
            home = result.stdout.strip()
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
            result = await self.conn.run("echo $HOME", check=False)
            home = result.stdout.strip()
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

        sftp = await self.get_sftp()
        if sftp is None:
            async for chunk in self._download_exec(remote_path):
                yield chunk
            return

        try:
            async for chunk in self._download_sftp(remote_path):
                yield chunk
        except Exception as e:
            logger.warning(f"SFTP download failed, falling back to exec: {e}")
            self._sftp_failed = True
            self.sftp = None
            async for chunk in self._download_exec(remote_path):
                yield chunk

    async def _download_sftp(self, remote_path: str):
        sftp = await self.get_sftp()
        async with sftp.open(remote_path, "rb") as f:
            while True:
                chunk = await f.read(65536)
                if not chunk:
                    break
                yield chunk

    async def _download_subprocess(self, remote_path: str):
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "BatchMode=yes", self.ssh_alias, f"cat {shlex.quote(remote_path)}",
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
            proc = await asyncio.create_subprocess_exec(
                "ssh", "-o", "BatchMode=yes", self.ssh_alias, f"cat {shlex.quote(remote_path)}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            with open(local_path, "wb") as f:
                while True:
                    chunk = await proc.stdout.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
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

        sftp = await self.get_sftp()
        if sftp is None:
            return await self._get_file_size_exec(remote_path)

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

    async def download_to_local(self, remote_path: str, local_path: str) -> None:
        """Copy a local file."""
        import shutil
        src = self._resolve_local_path(remote_path)
        shutil.copyfile(str(src), local_path)

    async def get_remote_file_size(self, remote_path: str) -> int:
        p = self._resolve_local_path(remote_path)
        return p.stat().st_size
