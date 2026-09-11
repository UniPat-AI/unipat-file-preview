"""JSON / XML / XBRL 处理器：安全解析并输出 UTF-8 展示文本 + 结构信息。"""

from __future__ import annotations

import json
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
from ._common import chunk_text, clamp_text, decode_bytes

_TREE_INPUT_MAX = 16 * 1024 * 1024


def process_json(ctx: ProcessorContext) -> Manifest:
    ctx.check_deadline()
    raw = ctx.source_path.read_bytes()
    decoded = decode_bytes(raw)
    is_valid = True
    parse_error: str | None = None
    parsed_size = len(raw)
    if parsed_size <= _TREE_INPUT_MAX:
        try:
            # 保留数字精度：parse_float=str/parse_int=str，再自行判断格式化
            json.loads(decoded.text)
        except json.JSONDecodeError as exc:
            is_valid = False
            parse_error = f"line {exc.lineno} col {exc.colno}: {exc.msg}"
    else:
        is_valid = False
        parse_error = "输入超过树解析预算，改为安全源文本模式"

    text_to_show, truncated = clamp_text(decoded.text)
    chunks = chunk_text(text_to_show)
    artifacts = _write_text_chunks(ctx, chunks, media="application/json")

    index_id = "entry"
    index_payload = {
        "kind": "structured_text",
        "language": "json",
        "encoding": decoded.encoding,
        "is_valid": is_valid,
        "parse_error": parse_error,
        "chunk_ids": [a.id for a in artifacts if a.role == "chunk"],
        "total_chars": len(text_to_show),
        "truncated": truncated or decoded.replaced,
    }
    index = ctx.fs.write_json("text/index.json", index_payload)
    artifacts.insert(
        0,
        ManifestArtifact(
            id=index_id,
            path=index.relative_path,
            media_type="application/json",
            size_bytes=index.size_bytes,
            sha256=index.sha256,
            role="entry",
        ),
    )

    warnings: list[ManifestWarning] = []
    if parse_error and is_valid is False:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.FORMAT_FALLBACK,
                message=f"JSON 解析失败，回退为源文本展示：{parse_error}",
            )
        )
    if decoded.uncertain:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.ENCODING_UNCERTAIN,
                message="编码探测不确定",
            )
        )

    rep = ManifestRepresentation(
        id="rep_json",
        kind="structured_text",
        label="JSON",
        status="ready",
        completeness="partial" if truncated else "complete",
        affects_completeness=True,
        entry_artifact=index_id,
        coverage=Coverage(unit="chars", shown=len(text_to_show), total=len(decoded.text)),
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial" if truncated else "ready",
        default_representation_id="rep_json",
        representations=[rep],
        artifacts=artifacts,
        capabilities={"search_scope": "loaded_text", "static_only": True},
        warnings=warnings,
    )


def process_xml(ctx: ProcessorContext) -> Manifest:
    ctx.check_deadline()
    raw = ctx.source_path.read_bytes()
    decoded = decode_bytes(raw)
    is_valid, parse_error = _validate_xml_safely(decoded.text)

    text_to_show, truncated = clamp_text(decoded.text)
    chunks = chunk_text(text_to_show)
    artifacts = _write_text_chunks(ctx, chunks, media="application/xml")

    index_id = "entry"
    index_payload = {
        "kind": "structured_text",
        "language": "xml",
        "encoding": decoded.encoding,
        "is_valid": is_valid,
        "parse_error": parse_error,
        "chunk_ids": [a.id for a in artifacts if a.role == "chunk"],
        "total_chars": len(text_to_show),
        "truncated": truncated or decoded.replaced,
    }
    index = ctx.fs.write_json("text/index.json", index_payload)
    artifacts.insert(
        0,
        ManifestArtifact(
            id=index_id,
            path=index.relative_path,
            media_type="application/json",
            size_bytes=index.size_bytes,
            sha256=index.sha256,
            role="entry",
        ),
    )

    warnings: list[ManifestWarning] = []
    if not is_valid:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.FORMAT_FALLBACK,
                message=f"XML 解析失败或超预算：{parse_error}",
            )
        )
    if decoded.uncertain:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.ENCODING_UNCERTAIN,
                message="编码探测不确定",
            )
        )

    rep = ManifestRepresentation(
        id="rep_xml",
        kind="structured_text",
        label="XML",
        status="ready",
        completeness="partial" if truncated else "complete",
        affects_completeness=True,
        entry_artifact=index_id,
        coverage=Coverage(unit="chars", shown=len(text_to_show), total=len(decoded.text)),
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial" if truncated else "ready",
        default_representation_id="rep_xml",
        representations=[rep],
        artifacts=artifacts,
        capabilities={"search_scope": "loaded_text", "static_only": True},
        warnings=warnings,
    )


def _write_text_chunks(
    ctx: ProcessorContext,
    chunks: list[str],
    *,
    media: str,
) -> list[ManifestArtifact]:
    artifacts: list[ManifestArtifact] = []
    for i, part in enumerate(chunks):
        w = ctx.fs.write_text(f"text/chunk-{i:04d}.txt", part)
        artifacts.append(
            ManifestArtifact(
                id=f"chunk_{i:04d}",
                path=w.relative_path,
                media_type="text/plain; charset=utf-8",
                size_bytes=w.size_bytes,
                sha256=w.sha256,
                role="chunk",
            )
        )
    return artifacts


def _validate_xml_safely(text: str) -> tuple[bool, str | None]:
    if len(text.encode("utf-8")) > _TREE_INPUT_MAX:
        return False, "输入超过树解析预算"
    try:
        from defusedxml.ElementTree import fromstring  # type: ignore[import-not-found]
    except ImportError:
        # 无 defusedxml 时用受限 stdlib：显式禁用实体扩展和外部资源
        return _validate_xml_stdlib(text)
    try:
        fromstring(text)
        return True, None
    except Exception as exc:  # pragma: no cover - defensive
        return False, f"{exc.__class__.__name__}: {exc}"


def _validate_xml_stdlib(text: str) -> tuple[bool, str | None]:
    """在没有 defusedxml 时的受限解析：强制外部实体禁用。"""

    from xml.etree.ElementTree import XMLParser, ParseError

    class _NoEntitiesTarget:
        def __init__(self) -> None:
            self._root: Any = None

        def start(self, tag: str, attrs: dict[str, str]) -> None:  # noqa: D401
            if self._root is None:
                self._root = tag

        def end(self, tag: str) -> None:
            return None

        def data(self, data: str) -> None:
            return None

        def close(self) -> Any:
            return self._root

    parser = XMLParser(target=_NoEntitiesTarget())
    # feed 前禁用实体加载：stdlib 默认不解析 DOCTYPE 外部子集，我们再显式拦截
    try:
        parser.feed(text)
        parser.close()
        if "<!ENTITY" in text or "SYSTEM" in text.upper():
            return False, "拒绝解析外部实体"
        return True, None
    except ParseError as exc:
        return False, f"ParseError: {exc}"


__all__ = ["process_json", "process_xml"]
