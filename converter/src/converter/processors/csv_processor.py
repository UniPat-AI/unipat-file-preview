"""CSV 处理器：流式解析 → 表格分块 + 工作簿索引。"""

from __future__ import annotations

import csv
import json
from io import StringIO
from typing import Iterable

from ..contracts import (
    Coverage,
    Manifest,
    ManifestArtifact,
    ManifestRepresentation,
    ManifestWarning,
)
from ..errors import ERROR_CODES
from ..runtime import ProcessorContext
from ._common import decode_bytes

_ROW_LIMIT = 200_000
_COL_LIMIT = 16_384
_CHUNK_ROWS = 1_000
_CHUNK_BYTES = 4 * 1024 * 1024


def process(ctx: ProcessorContext) -> Manifest:
    ctx.check_deadline()
    raw = ctx.source_path.read_bytes()
    decoded = decode_bytes(raw)
    text = decoded.text

    sample = text[: 32 * 1024]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(StringIO(text), dialect=dialect)

    chunks: list[dict] = []
    written: list[ManifestArtifact] = []
    max_cols = 0
    truncated_rows = False
    truncated_cols = False
    total_rows = 0

    current: list[list[str]] = []
    current_bytes = 0
    chunk_index = 0
    row_start = 1

    def flush() -> None:
        nonlocal current, current_bytes, chunk_index, row_start
        if not current:
            return
        payload = {
            "row_start": row_start,
            "row_end": row_start + len(current) - 1,
            "cells": current,
        }
        w = ctx.fs.write_json(f"table/chunk-{chunk_index:04d}.json", payload)
        chunks.append(
            {
                "row_start": payload["row_start"],
                "row_end": payload["row_end"],
                "col_start": 1,
                "col_end": max(len(r) for r in current) if current else 0,
                "artifact_id": f"chunk_{chunk_index:04d}",
                "size_bytes": w.size_bytes,
            }
        )
        written.append(
            ManifestArtifact(
                id=f"chunk_{chunk_index:04d}",
                path=w.relative_path,
                media_type="application/json",
                size_bytes=w.size_bytes,
                sha256=w.sha256,
                role="chunk",
            )
        )
        row_start = payload["row_end"] + 1
        chunk_index += 1
        current = []
        current_bytes = 0

    for row_idx, row in enumerate(reader, start=1):
        ctx.check_deadline()
        if row_idx > _ROW_LIMIT:
            truncated_rows = True
            break
        if len(row) > _COL_LIMIT:
            truncated_cols = True
            row = row[:_COL_LIMIT]
        max_cols = max(max_cols, len(row))
        row_bytes = sum(len(c.encode("utf-8")) for c in row) + len(row)
        if current_bytes + row_bytes > _CHUNK_BYTES and current:
            flush()
        if len(current) >= _CHUNK_ROWS:
            flush()
        current.append(row)
        current_bytes += row_bytes
        total_rows = row_idx
    flush()

    workbook = {
        "sheets": [
            {
                "sheet_id": "sheet_1",
                "name": "CSV",
                "order": 1,
                "visibility": "visible",
                "row_count": total_rows,
                "col_count": max_cols,
                "shown_row_end": total_rows,
                "shown_col_end": max_cols,
                "merges": [],
                "freeze": {"rows": 0, "cols": 0},
                "coverage": {
                    "unit": "rows",
                    "shown": total_rows,
                    "total": total_rows if not truncated_rows else None,
                },
                "chunks": chunks,
            }
        ],
        "styles_artifact_id": None,
        "capabilities": {"search_scope": "current_window", "static_only": True},
    }
    entry = ctx.fs.write_json("table/workbook.json", workbook)
    written.insert(
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

    warnings: list[ManifestWarning] = []
    if truncated_rows:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.ROW_LIMIT_REACHED,
                message=f"仅展示前 {_ROW_LIMIT} 行",
                scope="sheet_1",
            )
        )
    if truncated_cols:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.COL_LIMIT_REACHED,
                message=f"仅展示前 {_COL_LIMIT} 列",
                scope="sheet_1",
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
        id="rep_table",
        kind="table",
        label="表格",
        status="ready",
        completeness="partial" if (truncated_rows or truncated_cols) else "complete",
        affects_completeness=True,
        entry_artifact="entry",
        coverage=Coverage(unit="rows", shown=total_rows, total=None if truncated_rows else total_rows),
        warnings=warnings,
    )

    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial" if (truncated_rows or truncated_cols) else "ready",
        default_representation_id="rep_table",
        representations=[rep],
        artifacts=written,
        capabilities={"search_scope": "current_window", "static_only": True},
        warnings=warnings,
    )


__all__ = ["process"]


def _iter_stringio(text: str) -> Iterable[str]:  # pragma: no cover - unused helper
    yield text
