"""Notebook (.ipynb) 处理器：只提取受控字段，禁运行内核。"""

from __future__ import annotations

import json

from ..contracts import (
    Coverage,
    Manifest,
    ManifestArtifact,
    ManifestRepresentation,
    ManifestWarning,
)
from ..errors import ERROR_CODES, ConverterError
from ..runtime import ProcessorContext

_CELL_LIMIT = 500
_OUTPUT_CHAR_LIMIT = 2000
_CELL_SRC_LIMIT = 100_000
_TOTAL_TEXT_BUDGET = 10 * 1024 * 1024


def process(ctx: ProcessorContext) -> Manifest:
    ctx.check_deadline()
    raw = ctx.source_path.read_bytes()
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConverterError(
            ERROR_CODES.INVALID_CONVERSION_OUTPUT,
            f"Notebook JSON 解析失败：{exc}",
        )

    if not isinstance(doc, dict):
        raise ConverterError(
            ERROR_CODES.INVALID_CONVERSION_OUTPUT, "Notebook 根节点必须是对象"
        )
    cells = doc.get("cells")
    if not isinstance(cells, list):
        raise ConverterError(
            ERROR_CODES.INVALID_CONVERSION_OUTPUT, "cells 字段缺失或不是列表"
        )

    truncated_cells = len(cells) > _CELL_LIMIT
    if truncated_cells:
        cells = cells[:_CELL_LIMIT]

    out_cells: list[dict] = []
    total_chars = 0
    rich_omitted = 0
    for i, cell in enumerate(cells):
        ctx.check_deadline()
        if not isinstance(cell, dict):
            continue
        ctype = cell.get("cell_type", "raw")
        raw_source = cell.get("source", "")
        if isinstance(raw_source, list):
            raw_source = "".join(raw_source)
        elif not isinstance(raw_source, str):
            raw_source = str(raw_source)
        source_truncated = len(raw_source) > _CELL_SRC_LIMIT
        raw_source = raw_source[:_CELL_SRC_LIMIT]
        total_chars += len(raw_source)

        outputs_out: list[dict] = []
        for output in cell.get("outputs") or []:
            if not isinstance(output, dict):
                continue
            ot = output.get("output_type")
            if ot in {"stream"}:
                text = output.get("text")
                if isinstance(text, list):
                    text = "".join(text)
                text = (text or "")[:_OUTPUT_CHAR_LIMIT]
                total_chars += len(text)
                outputs_out.append(
                    {
                        "output_type": "stream",
                        "name": output.get("name", "stdout"),
                        "text": text,
                    }
                )
            elif ot in {"error"}:
                outputs_out.append(
                    {
                        "output_type": "error",
                        "ename": str(output.get("ename", ""))[:200],
                        "evalue": str(output.get("evalue", ""))[:400],
                        "traceback_summary": _summarize_traceback(
                            output.get("traceback")
                        )[:_OUTPUT_CHAR_LIMIT],
                    }
                )
            elif ot in {"execute_result", "display_data"}:
                data = output.get("data") or {}
                text_plain = data.get("text/plain")
                if isinstance(text_plain, list):
                    text_plain = "".join(text_plain)
                text_plain = (text_plain or "")[:_OUTPUT_CHAR_LIMIT]
                total_chars += len(text_plain)
                rich_present = any(k for k in data if k not in {"text/plain"})
                outputs_out.append(
                    {
                        "output_type": ot,
                        "text_plain": text_plain,
                        "rich_omitted": rich_present,
                    }
                )
                if rich_present:
                    rich_omitted += 1
            else:
                # 未识别类型：静默忽略
                continue
            if total_chars > _TOTAL_TEXT_BUDGET:
                break

        out_cells.append(
            {
                "index": i,
                "cell_type": ctype,
                "execution_count": cell.get("execution_count"),
                "source": raw_source,
                "source_truncated": source_truncated,
                "outputs": outputs_out,
            }
        )
        if total_chars > _TOTAL_TEXT_BUDGET:
            truncated_cells = True
            out_cells = out_cells[: len(out_cells)]
            break

    payload = {
        "kind": "notebook",
        "cells": out_cells,
        "cell_total": len(cells),
        "rich_omitted": rich_omitted,
    }
    entry = ctx.fs.write_json("notebook/entry.json", payload)
    artifacts: list[ManifestArtifact] = [
        ManifestArtifact(
            id="entry",
            path=entry.relative_path,
            media_type="application/json",
            size_bytes=entry.size_bytes,
            sha256=entry.sha256,
            role="entry",
        )
    ]

    warnings: list[ManifestWarning] = []
    if rich_omitted:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.RICH_OUTPUT_OMITTED,
                message=f"{rich_omitted} 个单元格包含未展示的富输出",
            )
        )
    completeness = "partial" if truncated_cells else "complete"

    rep = ManifestRepresentation(
        id="rep_notebook",
        kind="notebook",
        label="Notebook",
        status="ready",
        completeness=completeness,
        affects_completeness=True,
        entry_artifact="entry",
        coverage=Coverage(
            unit="cells", shown=len(out_cells), total=len(cells)
        ),
        warnings=warnings,
    )

    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial" if truncated_cells else "ready",
        default_representation_id="rep_notebook",
        representations=[rep],
        artifacts=artifacts,
        capabilities={"search_scope": "loaded_cells", "static_only": True},
        warnings=warnings,
    )


def _summarize_traceback(tb: object) -> str:
    if isinstance(tb, list):
        return "\n".join(str(x) for x in tb)
    if isinstance(tb, str):
        return tb
    return ""


__all__ = ["process"]
