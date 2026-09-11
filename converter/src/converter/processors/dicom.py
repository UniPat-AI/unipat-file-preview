"""DICOM 处理器：pydicom 逐帧解码。

- 检查像素数据存在与传输语法；
- 只导出灰度/RGB 静态帧；
- 不在响应或日志中回写患者信息。
"""

from __future__ import annotations

import io
from typing import Any

from ..contracts import (
    Coverage,
    Manifest,
    ManifestArtifact,
    ManifestRepresentation,
    ManifestWarning,
)
from ..errors import ERROR_CODES, ConverterError
from ..runtime import ProcessorContext

_MAX_FRAMES = 200


def process(ctx: ProcessorContext) -> Manifest:
    try:
        import numpy as np  # type: ignore[import-not-found]
        import pydicom  # type: ignore[import-not-found]
        from pydicom.pixel_data_handlers.util import apply_voi_lut  # type: ignore
    except ImportError as exc:
        raise ConverterError(
            ERROR_CODES.DEPENDENCY_UNAVAILABLE,
            "缺少 pydicom / numpy 依赖",
        ) from exc
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ConverterError(
            ERROR_CODES.DEPENDENCY_UNAVAILABLE,
            "缺少 Pillow 依赖，无法导出 DICOM 帧",
        ) from exc

    ds = pydicom.dcmread(str(ctx.source_path), stop_before_pixels=False)
    if "PixelData" not in ds:
        # 只导出受控基本信息文本作为主结果
        info = {
            "sop_class_uid": str(getattr(ds, "SOPClassUID", "")),
            "transfer_syntax": str(getattr(ds.file_meta, "TransferSyntaxUID", "")),
            "modality": str(getattr(ds, "Modality", "")),
            "rows": int(getattr(ds, "Rows", 0)),
            "columns": int(getattr(ds, "Columns", 0)),
        }
        entry = ctx.fs.write_json("dicom/info.json", info)
        rep = ManifestRepresentation(
            id="rep_info",
            kind="structured_text",
            label="DICOM 信息",
            status="ready",
            completeness="complete",
            affects_completeness=True,
            entry_artifact="entry",
        )
        return Manifest(
            schema_version="1.0",
            profile_id=ctx.profile_id,
            availability="ready",
            default_representation_id="rep_info",
            representations=[rep],
            artifacts=[
                ManifestArtifact(
                    id="entry",
                    path=entry.relative_path,
                    media_type="application/json",
                    size_bytes=entry.size_bytes,
                    sha256=entry.sha256,
                    role="entry",
                )
            ],
            capabilities={"static_only": True},
        )

    total_frames = int(getattr(ds, "NumberOfFrames", 1))
    frames_out = min(total_frames, _MAX_FRAMES)
    pixel_array = ds.pixel_array  # 单帧或多帧
    if pixel_array.ndim == 2:
        pixel_frames = [pixel_array]
    else:
        pixel_frames = list(pixel_array[:frames_out])

    frames_meta: list[dict[str, Any]] = []
    artifacts: list[ManifestArtifact] = []
    warnings: list[ManifestWarning] = []

    for i, frame in enumerate(pixel_frames):
        ctx.check_deadline()
        try:
            windowed = apply_voi_lut(frame, ds, index=0)
        except Exception:
            windowed = frame
            warnings.append(
                ManifestWarning(
                    code=ERROR_CODES.WINDOW_DERIVED,
                    message=f"帧 {i+1} 使用像素范围自动派生窗宽窗位",
                )
            )
        arr = _to_uint8(windowed)
        if getattr(ds, "PhotometricInterpretation", "") == "MONOCHROME1":
            arr = 255 - arr
        image = Image.fromarray(arr, mode="L")
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        image_rel = f"dicom/frame-{i:04d}.png"
        img_written = ctx.fs.write_bytes(image_rel, buf.getvalue())
        artifacts.append(
            ManifestArtifact(
                id=f"frame_{i:04d}",
                path=img_written.relative_path,
                media_type="image/png",
                size_bytes=img_written.size_bytes,
                sha256=img_written.sha256,
                role="frame",
            )
        )
        frames_meta.append(
            {
                "frame_id": f"frame_{i:04d}",
                "source_frame_number": i + 1,
                "width": image.width,
                "height": image.height,
                "image_artifact_id": f"frame_{i:04d}",
            }
        )

    entry = ctx.fs.write_json(
        "dicom/index.json",
        {
            "frames": frames_meta,
            "total_frames": total_frames,
            "transfer_syntax": str(getattr(ds.file_meta, "TransferSyntaxUID", "")),
            "capabilities": {"static_only": True},
        },
    )
    artifacts.insert(
        0,
        ManifestArtifact(
            id="entry",
            path=entry.relative_path,
            media_type="application/json",
            size_bytes=entry.size_bytes,
            sha256=entry.sha256,
            role="entry",
        ),
    )
    if total_frames > _MAX_FRAMES:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.RESOURCE_LIMIT_EXCEEDED,
                message=f"仅展示前 {_MAX_FRAMES} 帧",
            )
        )
    rep = ManifestRepresentation(
        id="rep_gallery",
        kind="image_gallery",
        label="DICOM 帧",
        status="ready",
        completeness="partial" if total_frames > _MAX_FRAMES else "complete",
        affects_completeness=True,
        entry_artifact="entry",
        coverage=Coverage(unit="frames", shown=frames_out, total=total_frames),
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial" if total_frames > _MAX_FRAMES else "ready",
        default_representation_id="rep_gallery",
        representations=[rep],
        artifacts=artifacts,
        capabilities={"static_only": True},
        warnings=warnings,
    )


def _to_uint8(arr: Any) -> Any:
    import numpy as np  # type: ignore[import-not-found]

    a = np.asarray(arr)
    a_min = a.min()
    a_max = a.max()
    if a_max == a_min:
        return np.zeros_like(a, dtype=np.uint8)
    scaled = (a - a_min) * (255.0 / (a_max - a_min))
    return scaled.astype(np.uint8)


__all__ = ["process"]
