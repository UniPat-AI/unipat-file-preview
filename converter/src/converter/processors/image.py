"""图片 / 多帧图像处理器（Pillow）。

- 应用 EXIF 朝向；
- 长边归一化到 2600px，缩略图 320px；
- 多帧最多 200 帧，超出记 partial；
- 生成 image_gallery 类型清单。
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
_LONG_EDGE = 2600
_THUMB = 320


def process(ctx: ProcessorContext) -> Manifest:
    try:
        from PIL import Image, ImageOps  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ConverterError(
            ERROR_CODES.DEPENDENCY_UNAVAILABLE,
            "缺少 Pillow 依赖，无法处理图像",
        ) from exc

    frames_meta: list[dict[str, Any]] = []
    artifacts: list[ManifestArtifact] = []
    warnings: list[ManifestWarning] = []
    try:
        img = Image.open(str(ctx.source_path))
    except Exception as exc:
        raise ConverterError(
            ERROR_CODES.INVALID_CONVERSION_OUTPUT,
            f"图像文件无法解码：{exc.__class__.__name__}",
        ) from exc

    total_frames = getattr(img, "n_frames", 1)
    frame_limit = min(total_frames, _MAX_FRAMES)
    for frame_index in range(frame_limit):
        ctx.check_deadline()
        img.seek(frame_index)
        frame = ImageOps.exif_transpose(img).convert("RGBA" if img.mode in {"P", "LA", "RGBA"} else "RGB")

        display = _fit_long_edge(frame, _LONG_EDGE)
        thumb = _fit_long_edge(frame, _THUMB)

        display_bytes = _encode_png_or_webp(display)
        thumb_bytes = _encode_png_or_webp(thumb)

        image_rel = f"images/frame-{frame_index:04d}.bin"
        thumb_rel = f"images/thumb-{frame_index:04d}.bin"
        img_written = ctx.fs.write_bytes(image_rel, display_bytes[1])
        thumb_written = ctx.fs.write_bytes(thumb_rel, thumb_bytes[1])
        artifacts.append(
            ManifestArtifact(
                id=f"frame_{frame_index:04d}",
                path=img_written.relative_path,
                media_type=display_bytes[0],
                size_bytes=img_written.size_bytes,
                sha256=img_written.sha256,
                role="frame",
            )
        )
        artifacts.append(
            ManifestArtifact(
                id=f"thumb_{frame_index:04d}",
                path=thumb_written.relative_path,
                media_type=thumb_bytes[0],
                size_bytes=thumb_written.size_bytes,
                sha256=thumb_written.sha256,
                role="thumbnail",
            )
        )
        frames_meta.append(
            {
                "frame_id": f"frame_{frame_index:04d}",
                "source_frame_number": frame_index + 1,
                "width": display.width,
                "height": display.height,
                "thumbnail_artifact_id": f"thumb_{frame_index:04d}",
                "image_artifact_id": f"frame_{frame_index:04d}",
                "source_dimensions": {"width": img.width, "height": img.height},
                "transforms": {"exif_transpose": True, "long_edge": _LONG_EDGE},
            }
        )

    entry = ctx.fs.write_json(
        "images/index.json",
        {
            "frames": frames_meta,
            "capabilities": {"static_only": True},
            "total_frames": total_frames if total_frames >= frame_limit else None,
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
        label="图像",
        status="ready",
        completeness="partial" if total_frames > frame_limit else "complete",
        affects_completeness=True,
        entry_artifact="entry",
        coverage=Coverage(unit="frames", shown=frame_limit, total=total_frames),
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial" if total_frames > frame_limit else "ready",
        default_representation_id="rep_gallery",
        representations=[rep],
        artifacts=artifacts,
        capabilities={"search_scope": None, "static_only": True},
        warnings=warnings,
    )


def _fit_long_edge(image: Any, long_edge: int) -> Any:
    w, h = image.size
    if max(w, h) <= long_edge:
        return image
    if w >= h:
        new_w = long_edge
        new_h = max(1, round(h * long_edge / w))
    else:
        new_h = long_edge
        new_w = max(1, round(w * long_edge / h))
    return image.resize((new_w, new_h))


def _encode_png_or_webp(image: Any) -> tuple[str, bytes]:
    buf = io.BytesIO()
    has_alpha = image.mode in {"RGBA", "LA"}
    if has_alpha:
        image.save(buf, format="PNG")
        return "image/png", buf.getvalue()
    image.save(buf, format="WEBP", quality=82, method=4)
    return "image/webp", buf.getvalue()


__all__ = ["process"]
