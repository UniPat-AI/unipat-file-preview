"""PDF 处理器：不重新排版，只做头校验 + 加密判定 + 结构性质抽取。

- 优先使用 pypdf（若可用）读取页数与加密标志；
- 无 pypdf 时用纯字节判定：文件头 ``%PDF-``、EOF 出现 ``%%EOF``、扫描 ``/Encrypt`` 关键字；
- 加密文件返回 ``PASSWORD_REQUIRED``；损坏返回 ``INVALID_CONVERSION_OUTPUT``。

处理器只把源文件登记为「source_reference 类型的入口产物」；host 决定是否直接使用源对象。
本地实现里把源字节复制一份到 output_dir 下，方便离线测试和 SHA 校验。
"""

from __future__ import annotations

import shutil
from pathlib import Path

from ..contracts import (
    Manifest,
    ManifestArtifact,
    ManifestRepresentation,
    ManifestWarning,
)
from ..errors import ERROR_CODES, ConverterError
from ..runtime import ProcessorContext
from ..sandbox_fs import compute_sha256_and_size


def _check_pdf_header_and_eof(path: Path) -> None:
    with open(path, "rb") as fh:
        head = fh.read(8)
        if not head.startswith(b"%PDF-"):
            raise ConverterError(
                ERROR_CODES.INVALID_CONVERSION_OUTPUT, "PDF 文件头缺失"
            )
        try:
            fh.seek(-1024, 2)
        except OSError:
            fh.seek(0)
        tail = fh.read()
        if b"%%EOF" not in tail:
            raise ConverterError(
                ERROR_CODES.INVALID_CONVERSION_OUTPUT, "PDF 末尾未发现 %%EOF"
            )


def _detect_encrypted_bytes(path: Path) -> bool:
    # 扫描是否存在 /Encrypt 关键字（简化判定，用于无 pypdf 的场景）
    needle = b"/Encrypt"
    with open(path, "rb") as fh:
        # 只读末尾 256 KiB，避免整文件遍历
        try:
            fh.seek(-256 * 1024, 2)
        except OSError:
            fh.seek(0)
        return needle in fh.read()


def _pypdf_stats(path: Path) -> tuple[int | None, bool | None]:
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError:
        return None, None
    try:
        reader = PdfReader(str(path))
        pages = len(reader.pages)
        encrypted = bool(getattr(reader, "is_encrypted", False))
        return pages, encrypted
    except Exception as exc:
        raise ConverterError(
            ERROR_CODES.INVALID_CONVERSION_OUTPUT,
            f"PDF 解析失败，文件损坏或结构无效：{exc}",
        ) from exc


def process(ctx: ProcessorContext) -> Manifest:
    ctx.check_deadline()
    src = ctx.source_path
    _check_pdf_header_and_eof(src)
    pages, encrypted = _pypdf_stats(src)
    if encrypted is None:
        encrypted = _detect_encrypted_bytes(src)
    if encrypted:
        raise ConverterError(
            ERROR_CODES.PASSWORD_REQUIRED, "PDF 已加密，无法预览"
        )

    # 把源文件登记为入口产物（受 SandboxFs 预算限制）
    target_relative = "pdf/entry.pdf"
    written = ctx.fs.copy_file(src, target_relative)

    artifact = ManifestArtifact(
        id="entry",
        path=target_relative,
        media_type="application/pdf",
        size_bytes=written.size_bytes,
        sha256=written.sha256,
        role="entry",
    )
    warnings: list[ManifestWarning] = []
    if pages is None:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.FORMAT_FALLBACK,
                message="pypdf 不可用，未能读取真实页数",
            )
        )

    rep = ManifestRepresentation(
        id="rep_pdf",
        kind="pdf",
        label="PDF",
        status="ready",
        completeness="complete",
        affects_completeness=True,
        entry_artifact="entry",
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="ready",
        default_representation_id="rep_pdf",
        representations=[rep],
        artifacts=[artifact],
        capabilities={
            "search_scope": "current_document",
            "static_only": True,
            "text_layer": pages is not None,
            "pages": pages,
        },
        warnings=warnings,
    )


__all__ = ["process"]
