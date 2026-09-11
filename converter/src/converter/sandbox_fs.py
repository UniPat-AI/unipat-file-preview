"""受限的输出文件系统封装。

- 所有写入必须通过 :class:`SandboxFs`，路径校验拒绝 ``..``、绝对路径、软链接和目录外引用。
- 写入采用「先写临时文件、关闭句柄后原子改名」的模式，避免 `result.json` 已存在但产物没写完。
- 内建 SHA-256 计算 + 总字节数预算校验；超过 ``output_bytes`` 直接抛 ``OUTPUT_TOO_LARGE``。
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable, Iterator

from .errors import ERROR_CODES, ConverterError

_CHUNK = 64 * 1024


@dataclass
class WrittenFile:
    relative_path: str
    size_bytes: int
    sha256: str


class SandboxFs:
    """限制在 ``output_dir`` 下的写入沙盒。"""

    def __init__(self, output_dir: str | os.PathLike[str], budget_bytes: int) -> None:
        self._root = Path(output_dir).resolve()
        if not self._root.exists():
            self._root.mkdir(parents=True, exist_ok=True)
        if not self._root.is_dir():
            raise ConverterError(
                ERROR_CODES.INVALID_REQUEST, f"output_dir 不是目录：{self._root}"
            )
        # 拒绝把整个输出目录本身指向软链接；仍允许项目层挂载卷。
        if self._root.is_symlink():
            raise ConverterError(
                ERROR_CODES.INVALID_REQUEST, "output_dir 不能是软链接"
            )
        self._budget = int(budget_bytes)
        self._used = 0

    @property
    def root(self) -> Path:
        return self._root

    @property
    def used_bytes(self) -> int:
        return self._used

    def resolve_child(self, relative: str) -> Path:
        if not isinstance(relative, str) or not relative:
            raise ConverterError(
                ERROR_CODES.INVALID_REQUEST, "artifact 相对路径必须非空"
            )
        if relative.startswith("/") or "\x00" in relative:
            raise ConverterError(
                ERROR_CODES.INVALID_REQUEST, f"非法 artifact 路径：{relative}"
            )
        parts = relative.replace("\\", "/").split("/")
        if any(p in ("", ".", "..") for p in parts):
            raise ConverterError(
                ERROR_CODES.INVALID_REQUEST, f"非法 artifact 路径：{relative}"
            )
        full = (self._root / Path(*parts)).resolve()
        try:
            full.relative_to(self._root)
        except ValueError as exc:  # pragma: no cover - defensive
            raise ConverterError(
                ERROR_CODES.INVALID_REQUEST,
                f"artifact 路径逃出 output_dir：{relative}",
            ) from exc
        return full

    def write_bytes(self, relative: str, data: bytes) -> WrittenFile:
        return self.write_stream(relative, _bytes_iter(data))

    def write_stream(
        self, relative: str, chunks: Iterable[bytes]
    ) -> WrittenFile:
        target = self.resolve_child(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        tmp_fd, tmp_path = tempfile.mkstemp(
            prefix=".tmp-", suffix=".part", dir=str(target.parent)
        )
        try:
            with os.fdopen(tmp_fd, "wb") as fh:
                for chunk in chunks:
                    if not chunk:
                        continue
                    self._reserve(len(chunk))
                    digest.update(chunk)
                    size += len(chunk)
                    fh.write(chunk)
            os.replace(tmp_path, target)
        except BaseException:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
            raise
        # 拒绝生成软链接（tempfile 不会，但显式复核一次）
        if target.is_symlink():
            target.unlink(missing_ok=True)
            raise ConverterError(
                ERROR_CODES.INVALID_CONVERSION_OUTPUT,
                "产物写出后检测到软链接",
            )
        return WrittenFile(
            relative_path=str(target.relative_to(self._root)).replace("\\", "/"),
            size_bytes=size,
            sha256=digest.hexdigest(),
        )

    def write_text(self, relative: str, text: str) -> WrittenFile:
        return self.write_bytes(relative, text.encode("utf-8"))

    def write_json(self, relative: str, payload: object) -> WrittenFile:
        encoded = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        return self.write_bytes(relative, encoded)

    def copy_file(self, src: Path | str, relative: str) -> WrittenFile:
        src_path = Path(src)
        def chunk_generator() -> Iterator[bytes]:
            with open(src_path, "rb") as fh:
                while chunk := fh.read(_CHUNK):
                    yield chunk
        return self.write_stream(relative, chunk_generator())

    def open_write(self, relative: str) -> "CountingWriter":
        target = self.resolve_child(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        return CountingWriter(target, self)

    def cleanup(self) -> None:
        shutil.rmtree(self._root, ignore_errors=True)

    def _reserve(self, n: int) -> None:
        if self._used + n > self._budget:
            raise ConverterError(
                ERROR_CODES.OUTPUT_TOO_LARGE,
                f"输出超过预算 {self._budget} bytes",
            )
        self._used += n


class CountingWriter:
    """流式写入并计算 SHA-256 / 大小。"""

    def __init__(self, target: Path, fs: SandboxFs) -> None:
        self._target = target
        self._fs = fs
        self._digest = hashlib.sha256()
        self._size = 0
        tmp_fd, tmp_path = tempfile.mkstemp(
            prefix=".tmp-", suffix=".part", dir=str(target.parent)
        )
        self._tmp_path = tmp_path
        self._fh: BinaryIO = os.fdopen(tmp_fd, "wb")

    def write(self, data: bytes) -> None:
        if not data:
            return
        self._fs._reserve(len(data))
        self._digest.update(data)
        self._size += len(data)
        self._fh.write(data)

    def close(self) -> WrittenFile:
        try:
            self._fh.flush()
            self._fh.close()
            os.replace(self._tmp_path, self._target)
        except BaseException:
            try:
                os.unlink(self._tmp_path)
            except FileNotFoundError:
                pass
            raise
        return WrittenFile(
            relative_path=str(
                self._target.relative_to(self._fs.root)
            ).replace("\\", "/"),
            size_bytes=self._size,
            sha256=self._digest.hexdigest(),
        )


def _bytes_iter(data: bytes) -> Iterator[bytes]:
    view = memoryview(data)
    for i in range(0, len(view), _CHUNK):
        yield bytes(view[i : i + _CHUNK])


def compute_sha256_and_size(path: str | os.PathLike[str]) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(_CHUNK)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


__all__ = [
    "SandboxFs",
    "CountingWriter",
    "WrittenFile",
    "compute_sha256_and_size",
]
