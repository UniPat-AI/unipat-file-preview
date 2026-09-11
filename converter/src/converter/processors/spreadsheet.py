"""Excel 处理器：openpyxl（XLSX/XLSM）+ xlrd（XLS，仅 1.2.0 支持 .xls）。

产出：
- ``table/workbook.json`` 工作簿入口；
- ``table/sheet-<sheet_id>-chunk-<n>.json`` 数据块；
- 每个工作表都遵守分块预算 1000 行 或 4 MiB；
- 达到 200000 行、16384 列上限时截断并 warning。
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path
from typing import Any, Iterable

from ..contracts import (
    Coverage,
    Manifest,
    ManifestArtifact,
    ManifestRepresentation,
    ManifestWarning,
)
from ..errors import ERROR_CODES, ConverterError
from ..runtime import ProcessorContext

_ROW_LIMIT = 200_000
_COL_LIMIT = 16_384
_CELL_LIMIT = 2_000_000
_CHUNK_ROWS = 1_000
_CHUNK_BYTES = 4 * 1024 * 1024


def process(ctx: ProcessorContext) -> Manifest:
    ext = ctx.extension
    if ext in {"xlsx", "xlsm"}:
        return _process_openpyxl(ctx)
    if ext == "xls":
        return _process_xlrd(ctx)
    raise ConverterError(
        ERROR_CODES.UNSUPPORTED_EXTENSION, f"spreadsheet 不支持扩展名 {ext}"
    )


def _process_openpyxl(ctx: ProcessorContext) -> Manifest:
    try:
        from openpyxl import load_workbook  # type: ignore[import-not-found]
        from openpyxl.utils.cell import coordinate_to_tuple
    except ImportError as exc:
        raise ConverterError(
            ERROR_CODES.DEPENDENCY_UNAVAILABLE,
            "缺少 openpyxl 依赖",
        ) from exc

    source_path = ctx.source_path
    cleanup_tmp_link: Path | None = None
    if source_path.suffix.lower() not in {".xlsx", ".xlsm", ".xltx", ".xltm"}:
        cleanup_tmp_link = source_path.parent / f"{source_path.stem}.xlsx"
        try:
            cleanup_tmp_link.symlink_to(source_path)
            source_path = cleanup_tmp_link
        except OSError:
            cleanup_tmp_link = None

    try:
        wb = load_workbook(filename=str(source_path), read_only=False, data_only=False)
    except Exception:
        wb = load_workbook(filename=str(source_path), read_only=True, data_only=False)

    sheets_meta: list[dict[str, Any]] = []
    artifacts: list[ManifestArtifact] = []
    warnings: list[ManifestWarning] = []
    cell_budget = _CELL_LIMIT

    for order, sheet_name in enumerate(wb.sheetnames, start=1):
        ctx.check_deadline()
        ws = wb[sheet_name]
        sheet_id = f"sheet_{order}"
        row_count = min(ws.max_row or 0, _ROW_LIMIT)
        col_count = min(ws.max_column or 0, _COL_LIMIT)
        truncated_rows = (ws.max_row or 0) > _ROW_LIMIT
        truncated_cols = (ws.max_column or 0) > _COL_LIMIT

        chunk_infos: list[dict[str, Any]] = []
        buf_rows: list[list[dict[str, Any]]] = []
        buf_bytes = 0
        chunk_idx = 0
        row_start = 1
        actual_last_row = 0

        def flush() -> None:
            nonlocal buf_rows, buf_bytes, chunk_idx, row_start
            if not buf_rows:
                return
            row_end = row_start + len(buf_rows) - 1
            payload = {
                "sheet_id": sheet_id,
                "row_start": row_start,
                "row_end": row_end,
                "rows": buf_rows,
            }
            written = ctx.fs.write_json(
                f"table/{sheet_id}-chunk-{chunk_idx:04d}.json", payload
            )
            artifact_id = f"{sheet_id}_chunk_{chunk_idx:04d}"
            chunk_infos.append(
                {
                    "row_start": row_start,
                    "row_end": row_end,
                    "col_start": 1,
                    "col_end": col_count,
                    "artifact_id": artifact_id,
                    "size_bytes": written.size_bytes,
                }
            )
            artifacts.append(
                ManifestArtifact(
                    id=artifact_id,
                    path=written.relative_path,
                    media_type="application/json",
                    size_bytes=written.size_bytes,
                    sha256=written.sha256,
                    role="chunk",
                )
            )
            row_start = row_end + 1
            chunk_idx += 1
            buf_rows = []
            buf_bytes = 0

        row_iter: Iterable[Any] = ws.iter_rows(
            min_row=1, max_row=row_count, max_col=col_count, values_only=False
        )
        for row_num, row in enumerate(row_iter, start=1):
            ctx.check_deadline()
            if row_num > row_count:
                break
            cells_out: list[dict[str, Any]] = []
            row_bytes = 0
            for cell in row:
                if cell is None:
                    continue
                if cell_budget <= 0:
                    truncated_rows = True
                    break
                value = cell.value
                if value is None:
                    continue
                actual_last_row = max(actual_last_row, cell.row)
                display = str(value)
                fmt = getattr(cell, "number_format", "") or ""
                if "%" in fmt and isinstance(value, (int, float)):
                    pct = value * 100
                    display = (
                        f"{pct:.2f}".rstrip("0").rstrip(".") + "%"
                        if "." in f"{pct:.2f}"
                        else f"{int(pct)}%"
                    )
                cell_entry = {
                    "row": cell.row,
                    "col": cell.column,
                    "type": _classify(value),
                    "raw_value": str(value),
                    "display_value": display,
                }
                cells_out.append(cell_entry)
                cell_budget -= 1
                row_bytes += len(json.dumps(cell_entry, ensure_ascii=False))
            buf_rows.append(cells_out)
            buf_bytes += row_bytes
            if buf_bytes > _CHUNK_BYTES or len(buf_rows) >= _CHUNK_ROWS:
                flush()
            if cell_budget <= 0:
                break
        flush()

        merges = (
            [str(rng) for rng in getattr(ws, "merged_cells", []).ranges]
            if getattr(ws, "merged_cells", None)
            else []
        )
        freeze = {"rows": 0, "cols": 0}
        if getattr(ws, "freeze_panes", None):
            try:
                fr_row, fr_col = coordinate_to_tuple(str(ws.freeze_panes))
                freeze = {"rows": fr_row - 1, "cols": fr_col - 1}
            except Exception:
                pass

        hidden_columns = []
        if getattr(ws, "column_dimensions", None):
            for col_letter, dim in ws.column_dimensions.items():
                if getattr(dim, "hidden", False):
                    hidden_columns.append(col_letter)

        shown_row_end = actual_last_row if actual_last_row > 0 else row_count
        sheets_meta.append(
            {
                "sheet_id": sheet_id,
                "name": sheet_name,
                "order": order,
                "visibility": _visibility(ws),
                "row_count": row_count,
                "col_count": col_count,
                "shown_row_end": shown_row_end,
                "shown_col_end": col_count,
                "merges": merges,
                "freeze": freeze,
                "hidden_columns": hidden_columns,
                "coverage": {
                    "unit": "rows",
                    "shown": shown_row_end,
                    "total": None if truncated_rows else row_count,
                },
                "chunks": chunk_infos,
            }
        )
        if truncated_rows:
            warnings.append(
                ManifestWarning(
                    code=ERROR_CODES.ROW_LIMIT_REACHED,
                    message=f"仅展示前 {_ROW_LIMIT} 行",
                    scope=sheet_id,
                )
            )
        if truncated_cols:
            warnings.append(
                ManifestWarning(
                    code=ERROR_CODES.COL_LIMIT_REACHED,
                    message=f"仅展示前 {_COL_LIMIT} 列",
                    scope=sheet_id,
                )
            )
    wb.close()

    entry = ctx.fs.write_json(
        "table/workbook.json",
        {
            "sheets": sheets_meta,
            "styles_artifact_id": None,
            "capabilities": {"search_scope": "current_window", "static_only": True},
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
    rep = ManifestRepresentation(
        id="rep_table",
        kind="table",
        label="表格",
        status="ready",
        completeness="partial" if warnings else "complete",
        affects_completeness=True,
        entry_artifact="entry",
        coverage=Coverage(
            unit="rows",
            shown=sum(s["row_count"] for s in sheets_meta),
            total=None,
        ),
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial" if warnings else "ready",
        default_representation_id="rep_table",
        representations=[rep],
        artifacts=artifacts,
        capabilities={"search_scope": "current_window", "static_only": True},
        warnings=warnings,
    )


def _process_xlrd(ctx: ProcessorContext) -> Manifest:
    try:
        import xlrd  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ConverterError(
            ERROR_CODES.DEPENDENCY_UNAVAILABLE,
            "缺少 xlrd 1.2.0 依赖（用于 .xls 支持）",
        ) from exc

    book = xlrd.open_workbook(filename=str(ctx.source_path))
    sheets_meta: list[dict[str, Any]] = []
    artifacts: list[ManifestArtifact] = []
    warnings: list[ManifestWarning] = []

    for order, sheet in enumerate(book.sheets(), start=1):
        ctx.check_deadline()
        sheet_id = f"sheet_{order}"
        row_count = min(sheet.nrows, _ROW_LIMIT)
        col_count = min(sheet.ncols, _COL_LIMIT)
        chunk_infos: list[dict[str, Any]] = []
        buf_rows: list[list[dict[str, Any]]] = []
        chunk_idx = 0
        row_start = 1

        def flush() -> None:
            nonlocal buf_rows, chunk_idx, row_start
            if not buf_rows:
                return
            row_end = row_start + len(buf_rows) - 1
            payload = {"sheet_id": sheet_id, "row_start": row_start, "row_end": row_end, "rows": buf_rows}
            written = ctx.fs.write_json(f"table/{sheet_id}-chunk-{chunk_idx:04d}.json", payload)
            artifact_id = f"{sheet_id}_chunk_{chunk_idx:04d}"
            chunk_infos.append(
                {
                    "row_start": row_start,
                    "row_end": row_end,
                    "col_start": 1,
                    "col_end": col_count,
                    "artifact_id": artifact_id,
                    "size_bytes": written.size_bytes,
                }
            )
            artifacts.append(
                ManifestArtifact(
                    id=artifact_id,
                    path=written.relative_path,
                    media_type="application/json",
                    size_bytes=written.size_bytes,
                    sha256=written.sha256,
                    role="chunk",
                )
            )
            row_start = row_end + 1
            chunk_idx += 1
            buf_rows = []

        for row_num in range(row_count):
            ctx.check_deadline()
            row_out: list[dict[str, Any]] = []
            for col_num in range(col_count):
                value = sheet.cell_value(row_num, col_num)
                if value == "" or value is None:
                    continue
                display = str(value)
                row_out.append(
                    {
                        "row": row_num + 1,
                        "col": col_num + 1,
                        "type": _classify(value),
                        "raw_value": display,
                        "display_value": display,
                    }
                )
            buf_rows.append(row_out)
            if len(buf_rows) >= _CHUNK_ROWS:
                flush()
        flush()

        sheets_meta.append(
            {
                "sheet_id": sheet_id,
                "name": sheet.name,
                "order": order,
                "visibility": "visible",
                "row_count": row_count,
                "col_count": col_count,
                "shown_row_end": row_count,
                "shown_col_end": col_count,
                "merges": [],
                "freeze": {"rows": 0, "cols": 0},
                "coverage": {"unit": "rows", "shown": row_count, "total": row_count},
                "chunks": chunk_infos,
            }
        )

    entry = ctx.fs.write_json(
        "table/workbook.json",
        {"sheets": sheets_meta, "styles_artifact_id": None, "capabilities": {"static_only": True}},
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
    warnings.append(
        ManifestWarning(
            code=ERROR_CODES.EMBEDDED_CONTENT_UNKNOWN,
            message="XLS 未提取公式源码与嵌入对象",
        )
    )
    rep = ManifestRepresentation(
        id="rep_table",
        kind="table",
        label="表格",
        status="ready",
        completeness="partial",
        affects_completeness=True,
        entry_artifact="entry",
        coverage=Coverage(unit="rows", shown=sum(s["row_count"] for s in sheets_meta), total=None),
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="partial",
        default_representation_id="rep_table",
        representations=[rep],
        artifacts=artifacts,
        capabilities={"search_scope": "current_window", "static_only": True},
        warnings=warnings,
    )


def _classify(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, (datetime.date, datetime.datetime)):
        return "date"
    if isinstance(value, str) and value.startswith("="):
        return "formula"
    return "string"


def _visibility(ws: Any) -> str:
    state = getattr(getattr(ws, "sheet_state", None), "value", None) or getattr(ws, "sheet_state", None)
    if state == "hidden":
        return "hidden"
    if state == "veryHidden":
        return "very_hidden"
    return "visible"


__all__ = ["process"]
