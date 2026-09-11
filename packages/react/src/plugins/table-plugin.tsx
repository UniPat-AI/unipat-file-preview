import React, { useMemo, useState } from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceText, inferFileName } from './utils.js';

export const TablePlugin: PreviewPlugin = {
  name: 'table',
  match: (fileType) => ['csv', 'tsv'].includes(fileType),
  Component: TableComponent,
};

function parseCsv(text: string): string[][] {
  
  const lines = text.split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const firstLine = lines[0] ?? '';
  let delimiter = ',';
  if (firstLine.includes('	')) delimiter = '	';
  else if (firstLine.includes(';') && !firstLine.includes(',')) delimiter = ';';

  return lines.map((line) => {
    const row: string[] = [];
    let insideQuote = false;
    let entry = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        insideQuote = !insideQuote;
      } else if (char === delimiter && !insideQuote) {
        row.push(entry.trim());
        entry = '';
      } else {
        entry += char;
      }
    }
    row.push(entry.trim());
    return row;
  });
}

function TableComponent({ src, className, style, onLoad, onError, fileName }: PreviewPluginProps) {
  const { text, loading, error } = useSourceText(src);
  const [page, setPage] = useState(0);
  const [pageSize] = useState(50);
  const displayName = inferFileName(src, fileName);

  const rows = useMemo(() => {
    if (!text) return [];
    return parseCsv(text);
  }, [text]);

  if (error) {
    onError?.(error);
    return <div style={styles.errorBox}>表格加载失败：{error.message}</div>;
  }

  if (loading) {
    return <div style={styles.loading}>解析表格中…</div>;
  }

  const header = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  const totalPages = Math.ceil(bodyRows.length / pageSize) || 1;
  const currentRows = bodyRows.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className={className} style={{ ...styles.container, ...style }}>
      <div style={styles.toolbar}>
        <span style={styles.fileName}>
          {displayName} <span style={styles.meta}>({rows.length} 行 · {header.length} 列)</span>
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
              {header.map((col, idx) => (
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
                {header.map((_, cIdx) => (
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
