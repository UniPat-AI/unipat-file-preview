"""处理器上下文与超时/资源限额调度。

- ``ProcessorContext`` 携带 request、限额、沙盒 FS、开始时间。
- ``TimeBudget`` 用一个 monotonic 时钟做统一超时判定，与 host 侧 480s 硬限一致。
- ``run_processor`` 是 host（HTTP 或 CLI）调用的入口：按扩展名选处理器、执行、组装 ConvertResult，并统一把内部异常规范化成错误码。
"""

from __future__ import annotations

import os
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .contracts import (
    CONTRACT_VERSION,
    ConvertRequest,
    ConvertResult,
    Manifest,
    ProcessorError,
)
from .errors import ERROR_CODES, ConverterError
from .sandbox_fs import SandboxFs, compute_sha256_and_size


class TimeBudget:
    """基于 monotonic 时钟的墙钟预算。"""

    def __init__(self, wall_time_seconds: float) -> None:
        self.limit = float(wall_time_seconds)
        self.started_at = time.monotonic()

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started_at

    @property
    def remaining(self) -> float:
        return max(0.0, self.limit - self.elapsed)

    def ensure(self) -> None:
        if self.elapsed >= self.limit:
            raise ConverterError(
                ERROR_CODES.CONVERSION_TIMEOUT,
                f"处理已超过 {self.limit:.1f}s",
            )


@dataclass
class ProcessorContext:
    request: ConvertRequest
    fs: SandboxFs
    budget: TimeBudget
    source_path: Path
    profile_id: str

    @property
    def extension(self) -> str:
        return self.request.source.extension.lower()

    def check_deadline(self) -> None:
        self.budget.ensure()


def build_context_from_request(request: ConvertRequest) -> ProcessorContext:
    source = Path(request.source.path)
    if not source.exists() or not source.is_file():
        raise ConverterError(
            ERROR_CODES.SOURCE_MISSING, f"源文件不存在或不可读：{source}"
        )
    if source.is_symlink():
        raise ConverterError(
            ERROR_CODES.INVALID_REQUEST, "源文件不能是软链接"
        )
    actual_sha, actual_size = compute_sha256_and_size(source)
    if actual_size != request.source.size_bytes:
        raise ConverterError(
            ERROR_CODES.INVALID_REQUEST,
            "source.size_bytes 与实际字节数不一致",
            details={"expected": request.source.size_bytes, "actual": actual_size},
        )
    if actual_sha.lower() != request.source.sha256.lower():
        raise ConverterError(
            ERROR_CODES.SOURCE_SHA_MISMATCH,
            "source.sha256 与实际摘要不一致",
        )
    fs = SandboxFs(request.output_dir, request.limits.output_bytes)
    budget = TimeBudget(request.limits.wall_time_seconds)
    return ProcessorContext(
        request=request,
        fs=fs,
        budget=budget,
        source_path=source,
        profile_id=request.profile.id,
    )


ProcessorFn = Callable[[ProcessorContext], Manifest]


def _resolve_processor(extension: str) -> ProcessorFn:
    # 延迟导入，避免测试 plain_text 时被 Pillow 缺失打断
    from .processors import (  # noqa: WPS433 - local import 是刻意的
        pdf as pdf_mod,
        office_pdf as office_pdf_mod,
        spreadsheet as spreadsheet_mod,
        csv_processor as csv_mod,
        image as image_mod,
        dicom as dicom_mod,
        html_sanitize as html_mod,
        structured_text as struct_mod,
        notebook as notebook_mod,
        plain_text as plain_mod,
    )

    ext = extension.lower().lstrip(".")
    mapping: dict[str, ProcessorFn] = {
        "pdf": pdf_mod.process,
        "doc": office_pdf_mod.process,
        "docx": office_pdf_mod.process,
        "rtf": office_pdf_mod.process,
        "ppt": office_pdf_mod.process,
        "pptx": office_pdf_mod.process,
        "xls": spreadsheet_mod.process,
        "xlsx": spreadsheet_mod.process,
        "xlsm": spreadsheet_mod.process,
        "csv": csv_mod.process,
        "png": image_mod.process,
        "jpg": image_mod.process,
        "jpeg": image_mod.process,
        "bmp": image_mod.process,
        "webp": image_mod.process,
        "tif": image_mod.process,
        "tiff": image_mod.process,
        "dcm": dicom_mod.process,
        "dicom": dicom_mod.process,
        "html": html_mod.process,
        "htm": html_mod.process,
        "xhtml": html_mod.process,
        "json": struct_mod.process_json,
        "xml": struct_mod.process_xml,
        "xbrl": struct_mod.process_xml,
        "ipynb": notebook_mod.process,
        "txt": plain_mod.process_txt,
        "md": plain_mod.process_md,
    }
    fn = mapping.get(ext)
    if fn is None:
        raise ConverterError(
            ERROR_CODES.UNSUPPORTED_EXTENSION,
            f"不支持的扩展名：{ext}",
        )
    return fn


def run_processor(request: ConvertRequest) -> ConvertResult:
    if request.contract_version != CONTRACT_VERSION:
        return ConvertResult(
            job_id=request.job_id,
            ok=False,
            error=ProcessorError(
                code=ERROR_CODES.INVALID_REQUEST,
                message=(
                    f"contract_version 不兼容：期望 {CONTRACT_VERSION}，"
                    f"收到 {request.contract_version}"
                ),
                retryable=False,
            ),
        )
    try:
        ctx = build_context_from_request(request)
        processor = _resolve_processor(ctx.extension)
        manifest = processor(ctx)
        _validate_manifest_paths(ctx, manifest)
        result = ConvertResult(job_id=request.job_id, ok=True, manifest=manifest)
        # result.json 写在 output_dir 根下
        ctx.fs.write_json("result.json", result.to_dict())
        return result
    except ConverterError as exc:
        return _write_failure(request, exc)
    except Exception as exc:  # pragma: no cover - 兜底
        details = {"trace": traceback.format_exc(limit=8)}
        err = ConverterError(
            ERROR_CODES.INTERNAL_ERROR,
            f"处理器内部错误：{exc.__class__.__name__}: {exc}",
            details=details,
        )
        return _write_failure(request, err)


def _validate_manifest_paths(ctx: ProcessorContext, manifest: Manifest) -> None:
    # 处理器可能声明产物但没实际写入；这里做一次强复核，避免发布不完整结果。
    seen: set[str] = set()
    for artifact in manifest.artifacts:
        path = ctx.fs.resolve_child(artifact.path)
        if not path.is_file():
            raise ConverterError(
                ERROR_CODES.INVALID_CONVERSION_OUTPUT,
                f"清单声明的产物不存在：{artifact.path}",
            )
        actual_sha, actual_size = compute_sha256_and_size(path)
        if actual_sha != artifact.sha256 or actual_size != artifact.size_bytes:
            raise ConverterError(
                ERROR_CODES.INVALID_CONVERSION_OUTPUT,
                f"产物 SHA/size 与清单不一致：{artifact.path}",
            )
        seen.add(artifact.path)
    # 校验 default representation 指向的入口存在
    if manifest.default_representation_id is not None:
        candidates = [
            r for r in manifest.representations if r.id == manifest.default_representation_id
        ]
        if not candidates:
            raise ConverterError(
                ERROR_CODES.INVALID_CONVERSION_OUTPUT,
                "default_representation_id 未在 representations 中找到",
            )
        entry = candidates[0].entry_artifact
        if entry and entry not in {a.id for a in manifest.artifacts if a.id}:
            raise ConverterError(
                ERROR_CODES.INVALID_CONVERSION_OUTPUT,
                f"default representation 的 entry_artifact 未在 artifacts 中登记：{entry}",
            )


def _write_failure(request: ConvertRequest, err: ConverterError) -> ConvertResult:
    result = ConvertResult(
        job_id=request.job_id,
        ok=False,
        error=ProcessorError(
            code=err.code, message=err.message, retryable=err.retryable
        ),
    )
    try:
        # 失败也尽量把 result.json 写到 output_dir 里，方便 host 收敛错误
        output_dir = Path(request.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        result_path = output_dir / "result.json"
        payload = result.to_dict()
        if err.details is not None:
            payload.setdefault("error", {})["details"] = err.details
        result_path.write_text(
            _dumps(payload), encoding="utf-8"
        )
    except Exception:  # pragma: no cover - best effort
        pass
    return result


def _dumps(payload: object) -> str:
    import json

    return json.dumps(payload, ensure_ascii=False, indent=2)


__all__ = [
    "ProcessorContext",
    "TimeBudget",
    "run_processor",
    "build_context_from_request",
]


# 便于测试：跳过实际 SHA 复核（例如单测用 stub 数据）
def _bypass_output_validation() -> None:  # pragma: no cover - test hook
    """占位：未来若加入 --skip-validation，从这里改。"""
    return None


assert os.name in {"nt", "posix"}  # 编译期断言，确保平台合规
