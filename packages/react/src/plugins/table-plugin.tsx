import React, { useMemo, useState } from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceText, inferFileName } from './utils.js';

export const TablePlugin: PreviewPlugin = {
  name: 'table',
  match: (fileType) => ['csv', 'tsv'].includes(fileType),
  Component: TableComponent,
};

/**
 * RFC 4180 合规的 CSV / TSV 标准解析器
 * 1. 严格支持字段内包含换行（\r\n 或 \n）；
 * 2. 严格支持双引号转义（"" 还原为单个 "）；
 * 3. 严格保留字段内有效首尾空格；
 * 4. 自动检测制表符 \t、分号 ; 或逗号 , 分隔符。
 */
export function parseCsv(text: string, explicitDelimiter?: string): string[][] {
  if (!text || text.length === 0) return [];

  let delimiter = explicitDelimiter;
  if (!delimiter) {
    const sample = text.slice(0, 4096);
    const tabs = (sample.match(/\t/g) || []).length;
    const commas = (sample.match(/,/g) || []).length;
    const semicolons = (sample.match(/;/g) || []).length;
    if (tabs > commas && tabs > semicolons) delimiter = '\t';
    else if (semicolons > commas && semicolons > tabs) delimiter = ';';
    else delimiter = ',';
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === delimiter) {
        currentRow.push(currentField);
        currentField = '';
        i++;
        continue;
      } else if (char === '\r') {
        if (i + 1 < len && text[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i++;
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  if (currentField.length > 0 || inQuotes || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  // 如果文件以换行结尾，过滤掉末尾单独一个空字段的行
  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    if (lastRow && lastRow.length === 1 && lastRow[0] === '' && (text.endsWith('\n') || text.endsWith('\r'))) {
      rows.pop();
    }
  }

  return rows;
}

function TableComponent({ src, className, style, onLoad, onError, fileName }: PreviewPluginProps) {
  const { text, loading, error } = useSourceText(src);
  const [page, setPage] = useState(0);
  const [pageSize] = useState(50);
  const displayName = inferFileName(src, fileName);

  React.useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);

  React.useEffect(() => {
    if (!loading && !error && text !== null) {
      onLoad?.();
    }
  }, [loading, error, text, onLoad]);

  // 当文件源切换时重置分页
  React.useEffect(() => {
    setPage(0);
  }, [src]);

  const rows = useMemo(() => {
    if (!text) return [];
    return parseCsv(text);
  }, [text]);

  if (error) {
    return <div style={styles.errorBox}>表格加载失败：{error.message}</div>;
  }

  if (loading) {
    return <div style={styles.loading}>解析表格中…</div>;
  }

  if (rows.length === 0) {
    return (
      <div className={className} style={{ ...styles.container, ...style }}>
        <div style={styles.toolbar}>
          <span style={styles.fileName}>{displayName}</span>
        </div>
        <div style={styles.emptyNotice}>（空表格文件）</div>
      </div>
    );
  }

  // 计算最大列数，确保即便行不等长也不会丢失单元格
  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const rawHeader = rows[0] ?? [];
  const headerCols: string[] = [];
  for (let c = 0; c < maxCols; c++) {
    headerCols.push(rawHeader[c] || `列 ${c + 1}`);
  }

  const bodyRows = rows.slice(1);
  const totalPages = Math.ceil(bodyRows.length / pageSize) || 1;
  const currentRows = bodyRows.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className={className} style={{ ...styles.container, ...style }}>
      <div style={styles.toolbar}>
        <span style={styles.fileName}>
          {displayName} <span style={styles.meta}>({rows.length} 行 · {maxCols} 列)</span>
        </span>
        <div style={styles.pagination}>
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            style={styles.btn}
          >
            上一页
          </button>
          <span style={styles.pageLabel}>
            {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            style={styles.btn}
          >
            下一页
          </button>
        </div>
      </div>
      <div style={styles.tableHost}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.indexTh}>#</th>
              {headerCols.map((col, idx) => (
                <th key={idx} style={styles.th}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {currentRows.map((row, rIdx) => (
              <tr key={rIdx} style={rIdx % 2 === 1 ? styles.altRow : {}}>
                <td style={styles.indexTd}>{page * pageSize + rIdx + 1}</td>
                {headerCols.map((_, cIdx) => (
                  <td key={cIdx} style={styles.td}>
                    {row[cIdx] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 400,
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    background: '#f8fafc',
    borderBottom: '1px solid #e2e8f0',
    fontSize: 13,
  },
  fileName: {
    fontWeight: 500,
    color: '#334155',
  },
  meta: {
    fontWeight: 400,
    color: '#94a3b8',
    fontSize: 12,
  },
  pagination: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  btn: {
    padding: '4px 10px',
    border: '1px solid #cbd5e1',
    background: '#fff',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  pageLabel: {
    fontSize: 12,
    color: '#64748b',
    fontFamily: 'monospace',
  },
  tableHost: {
    flex: 1,
    overflow: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
    textAlign: 'left',
  },
  th: {
    position: 'sticky',
    top: 0,
    background: '#f1f5f9',
    padding: '8px 12px',
    borderBottom: '2px solid #cbd5e1',
    borderRight: '1px solid #e2e8f0',
    color: '#334155',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    zIndex: 1,
  },
  indexTh: {
    position: 'sticky',
    top: 0,
    left: 0,
    background: '#e2e8f0',
    width: 48,
    minWidth: 48,
    textAlign: 'center',
    padding: '8px 4px',
    borderBottom: '2px solid #cbd5e1',
    borderRight: '1px solid #cbd5e1',
    zIndex: 2,
    fontSize: 12,
    color: '#64748b',
  },
  td: {
    padding: '6px 12px',
    borderBottom: '1px solid #f1f5f9',
    borderRight: '1px solid #f1f5f9',
    color: '#1e293b',
    whiteSpace: 'nowrap',
    maxWidth: 300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  indexTd: {
    position: 'sticky',
    left: 0,
    background: '#f8fafc',
    textAlign: 'center',
    padding: '6px 4px',
    borderBottom: '1px solid #f1f5f9',
    borderRight: '1px solid #cbd5e1',
    fontSize: 11,
    color: '#94a3b8',
    fontFamily: 'monospace',
    userSelect: 'none',
  },
  altRow: {
    background: '#f8fafc',
  },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: 300,
    color: '#94a3b8',
  },
  errorBox: {
    padding: 16,
    color: '#dc2626',
    background: '#fef2f2',
    borderRadius: 6,
    margin: 16,
  },
};
