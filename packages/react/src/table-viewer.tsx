import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SHEET_WINDOW_MAX_COLS,
  SHEET_WINDOW_MAX_ROWS,
  type SheetCell,
} from './contracts/index.js';
import type { ViewerContext } from './viewers.js';
import { useSheetWindow } from './hooks/use-sheet-window.js';

const DEFAULT_ROW_STRIDE = Math.min(50, SHEET_WINDOW_MAX_ROWS);
const DEFAULT_COL_STRIDE = Math.min(20, SHEET_WINDOW_MAX_COLS);

interface SheetMeta {
  sheet_id: string;
  name: string;
  order: number;
  visibility: string;
  row_count: number;
  col_count: number;
  merges?: string[];
  freeze?: { rows: number; cols: number };
}

export function TableViewer({
  client,
  previewId,
  publishedRevision,
  artifact,
}: ViewerContext) {
  const [sheets, setSheets] = useState<SheetMeta[]>([]);
  const [activeSheetId, setActiveSheetId] = useState<string>('sheet_1');
  const [rowOffset, setRowOffset] = useState(1);
  const [colOffset, setColOffset] = useState(1);

  useEffect(() => {
    const ac = new AbortController();
    client
      .fetchArtifact({
        previewId,
        publishedRevision,
        artifactId: artifact.artifactId,
        signal: ac.signal,
      })
      .then((buf) => {
        if (ac.signal.aborted) return;
        try {
          const wb = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf))) as {
            sheets?: SheetMeta[];
          };
          if (Array.isArray(wb.sheets) && wb.sheets.length > 0) {
            setSheets(wb.sheets);
            const firstVisible = wb.sheets.find((s) => s.visibility !== 'hidden') ?? wb.sheets[0]!;
            setActiveSheetId(firstVisible.sheet_id);
          }
        } catch {
          // not workbook json
        }
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [client, previewId, publishedRevision, artifact.artifactId]);

  const { window: win, loading, error } = useSheetWindow({
    client,
    previewId,
    publishedRevision,
    sheetId: activeSheetId,
    rowStart: rowOffset,
    rowEnd: rowOffset + DEFAULT_ROW_STRIDE - 1,
    colStart: colOffset,
    colEnd: colOffset + DEFAULT_COL_STRIDE - 1,
  });

  const currentSheetMeta = sheets.find((s) => s.sheet_id === activeSheetId);
  const mergeMap = useMemo(
    () =>
      buildMergeMap(
        currentSheetMeta?.merges ?? (win?.merges as string[] | undefined),
        rowOffset,
        rowOffset + DEFAULT_ROW_STRIDE - 1,
      ),
    [currentSheetMeta?.merges, win?.merges, rowOffset],
  );
  const grid = useMemo(
    () =>
      win
        ? buildGrid(
            win.cells,
            rowOffset,
            rowOffset + DEFAULT_ROW_STRIDE - 1,
            colOffset,
            colOffset + DEFAULT_COL_STRIDE - 1,
          )
        : null,
    [win, rowOffset, colOffset],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const canPrevRow = rowOffset > 1;
  const canPrevCol = colOffset > 1;

  const nextRows = () => setRowOffset((r) => r + DEFAULT_ROW_STRIDE);
  const prevRows = () =>
    setRowOffset((r) => Math.max(1, r - DEFAULT_ROW_STRIDE));
  const nextCols = () => setColOffset((c) => c + DEFAULT_COL_STRIDE);
  const prevCols = () =>
    setColOffset((c) => Math.max(1, c - DEFAULT_COL_STRIDE));
  const goHome = () => {
    setRowOffset(1);
    setColOffset(1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'PageDown') {
      e.preventDefault();
      nextRows();
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      if (canPrevRow) prevRows();
    } else if (e.key === 'ArrowRight' && e.altKey) {
      e.preventDefault();
      nextCols();
    } else if (e.key === 'ArrowLeft' && e.altKey) {
      e.preventDefault();
      if (canPrevCol) prevCols();
    } else if (e.key === 'Home') {
      e.preventDefault();
      goHome();
    }
  };

  if (error) {
    return (
      <div style={styles.errorBox} role="alert">
        <p style={{ margin: 0, fontWeight: 600 }}>
          Table window unavailable · <code>{error.code}</code>
        </p>
        <p style={{ margin: '4px 0 0' }}>{error.message}</p>
      </div>
    );
  }

  const totalRows = win?.coverage?.total ?? currentSheetMeta?.row_count ?? -1;

  return (
    <div
      style={styles.wrapper}
      role="region"
      aria-label="表格预览"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {sheets.length > 1 ? (
        <div style={styles.sheetTabs} role="tablist">
          {sheets.map((s) => (
            <button
              key={s.sheet_id}
              type="button"
              role="tab"
              aria-selected={s.sheet_id === activeSheetId}
              style={{
                ...styles.sheetTab,
                ...(s.sheet_id === activeSheetId ? styles.sheetTabActive : {}),
              }}
              onClick={() => {
                setActiveSheetId(s.sheet_id);
                setRowOffset(1);
                setColOffset(1);
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}

      <div style={styles.toolbar}>
        <button
          type="button"
          style={styles.navBtn}
          disabled={!canPrevRow}
          onClick={prevRows}
          aria-label="上一页行 (PageUp)"
        >
          ↑ prev {DEFAULT_ROW_STRIDE} rows
        </button>
        <button
          type="button"
          style={styles.navBtn}
          onClick={nextRows}
          aria-label="下一页行 (PageDown)"
        >
          ↓ next {DEFAULT_ROW_STRIDE} rows
        </button>
        <span style={styles.meta} aria-live="polite">
          rows [{rowOffset}, {rowOffset + DEFAULT_ROW_STRIDE - 1}] · cols [
          {colOffset}, {colOffset + DEFAULT_COL_STRIDE - 1}]
        </span>
        <button
          type="button"
          style={styles.navBtn}
          disabled={!canPrevCol}
          onClick={prevCols}
          aria-label="上一页列 (Alt+←)"
        >
          ← prev cols
        </button>
        <button
          type="button"
          style={styles.navBtn}
          onClick={nextCols}
          aria-label="下一页列 (Alt+→)"
        >
          next cols →
        </button>
      </div>

      <div ref={scrollRef} style={styles.scrollHost}>
        {loading || !grid ? (
          <div style={styles.skeleton}>Loading sheet window…</div>
        ) : (
          <table
            style={styles.table}
            role="table"
            aria-rowcount={totalRows}
            aria-colcount={-1}
          >
            <thead>
              <tr>
                <th style={styles.headerCorner} />
                {grid.cols.map((col) => (
                  <th key={col} style={styles.headerCell} scope="col">
                    {colLabel(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row) => (
                <tr key={row} aria-rowindex={row}>
                  <th style={styles.rowHeader} scope="row">
                    {row}
                  </th>
                  {grid.cols.map((col) => {
                    const span = mergeMap.get(cellKey(row, col));
                    if (span && span.rowSpan === 0) {
                      return null; // 被跨行或跨列合并覆盖，按 GDPVal-V2 方案不渲染占位
                    }
                    const cell = grid.map.get(cellKey(row, col));
                    return (
                      <td
                        key={col}
                        rowSpan={span && span.rowSpan > 1 ? span.rowSpan : undefined}
                        colSpan={span && span.colSpan > 1 ? span.colSpan : undefined}
                        style={{
                          ...styles.bodyCell,
                          textAlign:
                            cell?.type === 'number' ? 'right' : 'left',
                          color:
                            cell?.type === 'error' ? '#c53030' : 'inherit',
                        }}
                        title={cell?.formula ?? undefined}
                      >
                        {renderCell(cell)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {win?.coverage ? (
        <div style={styles.footer}>
          coverage: {win.coverage.shown} / {win.coverage.total ?? '?'}{' '}
          {win.coverage.unit}
        </div>
      ) : null}
    </div>
  );
}

function colNameToNumber(name: string): number {
  let num = 0;
  for (let i = 0; i < name.length; i++) {
    num = num * 26 + (name.charCodeAt(i) - 64);
  }
  return num;
}

function parseMergeRange(rangeStr: string): [number, number, number, number] | null {
  const m = rangeStr.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!m) return null;
  const col1 = colNameToNumber(m[1]!);
  const row1 = parseInt(m[2]!, 10);
  const col2 = colNameToNumber(m[3]!);
  const row2 = parseInt(m[4]!, 10);
  return [row1, col1, row2, col2];
}

/**
 * 移植自 GDPVal-V2 填坑方案：
 * 把 sheet 级的合并区折算成「当前分页里每个单元格的 rowSpan/colSpan」。
 * 合并区可能跨分页边界，按 [startRow, endRow] 裁剪，跨界时截到本页可见行数，被覆盖格返回 span: 0。
 */
function buildMergeMap(
  merges: string[] | undefined,
  startRow: number,
  endRow: number,
): Map<string, { rowSpan: number; colSpan: number }> {
  const map = new Map<string, { rowSpan: number; colSpan: number }>();
  if (!merges || merges.length === 0) return map;

  for (const mergeStr of merges) {
    const range = parseMergeRange(mergeStr);
    if (!range) continue;
    const [r1, c1, r2, c2] = range;
    if (r2 < startRow || r1 > endRow) continue; // 整个合并区不在当前视口
    const from = Math.max(r1, startRow);
    const to = Math.min(r2, endRow);
    for (let r = from; r <= to; r++) {
      for (let c = c1; c <= c2; c++) {
        const isAnchor = r === from && c === c1;
        map.set(
          `${r}:${c}`,
          isAnchor
            ? { rowSpan: to - from + 1, colSpan: c2 - c1 + 1 }
            : { rowSpan: 0, colSpan: 0 },
        );
      }
    }
  }
  return map;
}

function buildGrid(
  cells: readonly SheetCell[],
  rowStart: number,
  rowEnd: number,
  colStart: number,
  colEnd: number,
) {
  const map = new Map<string, SheetCell>();
  for (const cell of cells) {
    map.set(cellKey(cell.row, cell.col), cell);
  }
  const rows: number[] = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    rows.push(r);
  }
  const cols: number[] = [];
  for (let c = colStart; c <= colEnd; c++) {
    cols.push(c);
  }
  return {
    rows,
    cols,
    map,
  };
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

// 移植自 GDPVal-V2：1-based 列索引转 Excel 字母（1 -> A, 26 -> Z, 27 -> AA）
function colLabel(col: number): string {
  let name = '';
  let value = col;
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function renderCell(cell: SheetCell | undefined): string {
  if (!cell) return '';
  if (cell.displayValue !== null && cell.displayValue !== undefined) return cell.displayValue;
  if (cell.rawValue !== null && cell.rawValue !== undefined) return cell.rawValue;
  if (cell.cachedValue !== null && cell.cachedValue !== undefined) return cell.cachedValue;
  return '';
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { display: 'flex', flexDirection: 'column', gap: 8 },
  sheetTabs: {
    display: 'flex',
    gap: 4,
    borderBottom: '1px solid #e2e8f0',
    paddingBottom: 4,
  },
  sheetTab: {
    padding: '4px 12px',
    border: '1px solid #cbd5e0',
    background: '#edf2f7',
    borderRadius: '4px 4px 0 0',
    cursor: 'pointer',
    fontSize: 12,
    color: '#4a5568',
  },
  sheetTabActive: {
    background: '#fff',
    borderBottomColor: '#fff',
    fontWeight: 600,
    color: '#2b6cb0',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '4px 8px',
    background: '#f7fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    fontSize: 12,
    color: '#4a5568',
  },
  navBtn: {
    padding: '4px 8px',
    border: '1px solid #cbd5e0',
    background: '#fff',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  meta: { fontFamily: 'monospace', marginLeft: 'auto', marginRight: 'auto' },
  scrollHost: {
    maxHeight: 480,
    overflow: 'auto',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    background: '#fff',
  },
  skeleton: { padding: 16, color: '#718096', fontStyle: 'italic' },
  table: {
    borderCollapse: 'collapse',
    fontSize: 12,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    minWidth: '100%',
  },
  headerCorner: {
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 3,
    background: '#edf2f7',
    borderBottom: '1px solid #cbd5e0',
    borderRight: '1px solid #cbd5e0',
  },
  headerCell: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: '#edf2f7',
    borderBottom: '1px solid #cbd5e0',
    borderRight: '1px solid #e2e8f0',
    padding: '4px 8px',
    minWidth: 80,
  },
  rowHeader: {
    position: 'sticky',
    left: 0,
    zIndex: 1,
    background: '#f7fafc',
    borderRight: '1px solid #cbd5e0',
    borderBottom: '1px solid #e2e8f0',
    padding: '4px 8px',
    textAlign: 'right',
    fontWeight: 500,
  },
  bodyCell: {
    borderBottom: '1px solid #edf2f7',
    borderRight: '1px solid #edf2f7',
    padding: '4px 8px',
    whiteSpace: 'nowrap',
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  footer: {
    fontSize: 11,
    color: '#718096',
    fontFamily: 'monospace',
    textAlign: 'right',
  },
  errorBox: {
    padding: 12,
    background: '#fff5f5',
    border: '1px solid #feb2b2',
    color: '#742a2a',
    borderRadius: 6,
    fontSize: 13,
  },
};
