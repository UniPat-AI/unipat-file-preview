"""TXT/MD 处理器：输出 UTF-8 归一化文本 + 分块索引 + 提示。"""

from __future__ import annotations

from ..contracts import (
    Coverage,
    Manifest,
    ManifestArtifact,
    ManifestRepresentation,
    ManifestWarning,
)
from ..errors import ERROR_CODES
from ..runtime import ProcessorContext
from ._common import chunk_text, clamp_text, decode_bytes


def _process_plain(ctx: ProcessorContext, kind: str, label: str) -> Manifest:
    ctx.check_deadline()
    raw = ctx.source_path.read_bytes()
    decoded = decode_bytes(raw)
    text, truncated = clamp_text(decoded.text)
    chunks = chunk_text(text)

    written_ids: list[str] = []
    artifacts: list[ManifestArtifact] = []
    total_chars = 0
    for i, part in enumerate(chunks):
        w = ctx.fs.write_text(f"text/chunk-{i:04d}.txt", part)
        aid = f"chunk_{i:04d}"
        written_ids.append(aid)
        artifacts.append(
            ManifestArtifact(
                id=aid,
                path=w.relative_path,
                media_type="text/plain; charset=utf-8",
                size_bytes=w.size_bytes,
                sha256=w.sha256,
                role="chunk",
            )
        )
        total_chars += len(part)

    index_payload = {
        "kind": kind,
        "encoding": decoded.encoding,
        "chunk_ids": written_ids,
        "total_chars": total_chars,
        "truncated": truncated or decoded.replaced,
    }
    index = ctx.fs.write_json("text/index.json", index_payload)
    entry_id = "entry"
    artifacts.insert(
        0,
        ManifestArtifact(
            id=entry_id,
            path=index.relative_path,
            media_type="application/json",
            size_bytes=index.size_bytes,
            sha256=index.sha256,
            role="entry",
        ),
    )

    warnings: list[ManifestWarning] = []
    if decoded.uncertain:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.ENCODING_UNCERTAIN,
                message="编码探测不确定，已使用替换字符恢复展示",
            )
        )

    representation = ManifestRepresentation(
        id="rep_text",
        kind=kind,  # type: ignore[arg-type]
        label=label,
        status="ready",
        completeness="partial" if truncated else "complete",
        affects_completeness=True,
        entry_artifact=entry_id,
        coverage=Coverage(
            unit="chars",
            shown=total_chars,
            total=len(decoded.text),
        ),
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial" if truncated else "ready",
        default_representation_id="rep_text",
        representations=[representation],
        artifacts=artifacts,
        capabilities={"search_scope": "loaded_text", "static_only": True},
        warnings=warnings,
    )


def process_txt(ctx: ProcessorContext) -> Manifest:
    return _process_plain(ctx, kind="plain_text", label="文本")


def process_md(ctx: ProcessorContext) -> Manifest:
    return _process_plain(ctx, kind="plain_text", label="Markdown")
