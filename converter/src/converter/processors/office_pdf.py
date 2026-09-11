"""Office → PDF：调用 libreoffice --headless 转成 PDF。

- 每次转换使用独立 user profile，避免共享锁；
- 通过 ``subprocess.run(..., timeout=budget.remaining)`` 强制超时；
- 转换后再走 pdf 处理器的验证逻辑，登记为 pdf 入口。
- 若容器中没有 libreoffice，返回 ``DEPENDENCY_UNAVAILABLE``。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
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


def _find_libreoffice() -> str | None:
    for candidate in ("soffice", "libreoffice"):
        found = shutil.which(candidate)
        if found:
            return found
    return None


def process(ctx: ProcessorContext) -> Manifest:
    ctx.check_deadline()
    soffice = _find_libreoffice()
    if soffice is None:
        raise ConverterError(
            ERROR_CODES.DEPENDENCY_UNAVAILABLE,
            "缺少 libreoffice / soffice 可执行，无法执行 Office → PDF",
            details={"needed": "libreoffice"},
        )

    tmp_root = Path(tempfile.mkdtemp(prefix="office-", dir=str(ctx.fs.root)))
    user_profile = tmp_root / "profile"
    user_profile.mkdir(parents=True, exist_ok=True)
    work_dir = tmp_root / "work"
    work_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        soffice,
        f"-env:UserInstallation=file://{user_profile}",
        "--headless",
        "--norestore",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        "pdf",
        "--outdir",
        str(work_dir),
        str(ctx.source_path),
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=max(30.0, ctx.budget.remaining),
            env={**os.environ, "HOME": str(user_profile)},
        )
    except subprocess.TimeoutExpired as exc:
        raise ConverterError(
            ERROR_CODES.CONVERSION_TIMEOUT, "LibreOffice 导出超时"
        ) from exc

    if proc.returncode != 0:
        detail = (proc.stderr or b"").decode("utf-8", errors="replace")[:2048]
        raise ConverterError(
            ERROR_CODES.INVALID_CONVERSION_OUTPUT,
            "LibreOffice 转换失败",
            details={"stderr": detail, "returncode": proc.returncode},
        )

    # LibreOffice 会以源文件名 + .pdf 保存
    candidates = list(work_dir.glob("*.pdf"))
    if not candidates:
        raise ConverterError(
            ERROR_CODES.INVALID_CONVERSION_OUTPUT,
            "LibreOffice 未产出 PDF",
        )
    src_pdf = candidates[0]

    # 校验产出的 PDF 是否具有基本合法性
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
        reader = PdfReader(str(src_pdf))
        _ = len(reader.pages)
    except ImportError:
        pass
    except Exception as exc:
        raise ConverterError(
            ERROR_CODES.INVALID_CONVERSION_OUTPUT,
            f"LibreOffice 产出 PDF 损坏：{exc}",
        ) from exc

    target_relative = "pdf/entry.pdf"
    written = ctx.fs.copy_file(src_pdf, target_relative)

    # 收尾清理临时目录，减少 output_dir 里的额外文件
    shutil.rmtree(tmp_root, ignore_errors=True)

    artifact = ManifestArtifact(
        id="entry",
        path=target_relative,
        media_type="application/pdf",
        size_bytes=written.size_bytes,
        sha256=written.sha256,
        role="entry",
    )
    warnings: list[ManifestWarning] = []
    if b"FontSubstitution" in (proc.stderr or b""):
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.FONT_SUBSTITUTED,
                message="转换过程中出现字体替换",
            )
        )

    rep = ManifestRepresentation(
        id="rep_pdf",
        kind="pdf",
        label="打印版",
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
        capabilities={"search_scope": "current_document", "static_only": True},
        warnings=warnings,
    )


__all__ = ["process"]
