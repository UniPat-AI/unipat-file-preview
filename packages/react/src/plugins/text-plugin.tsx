import React, { useState } from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceText, inferFileName } from './utils.js';

export const TextPlugin: PreviewPlugin = {
  name: 'text',
  match: (fileType) =>
    [
      'txt',
      'text',
      'md',
      'markdown',
      'json',
      'js',
      'ts',
      'jsx',
      'tsx',
      'css',
      'xml',
      'yaml',
      'yml',
      'sql',
      'sh',
      'bash',
      'py',
      'java',
      'go',
      'rs',
      'c',
      'cpp',
      'log',
      'ini',
      'conf',
    ].includes(fileType),
  Component: TextComponent,
};

function TextComponent({ src, fileType, fileName, className, style, onLoad, onError }: PreviewPluginProps) {
  const { text, loading, error } = useSourceText(src);
  const [copied, setCopied] = useState(false);
  const displayName = inferFileName(src, fileName);

  React.useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);

  React.useEffect(() => {
    if (!loading && !error && text !== null) {
      onLoad?.();
    }
  }, [loading, error, text, onLoad]);

  if (error) {
    return <div style={styles.errorBox}>文本加载失败：{error.message}</div>;
  }

  if (loading) {
    return <div style={styles.loading}>加载文本中…</div>;
  }

  let formattedText = text ?? '';
  if (fileType === 'json' && text) {
    try {
      formattedText = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // not valid json, keep raw
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formattedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const lines = formattedText.split(String.fromCharCode(10));

  return (
    <div className={className} style={{ ...styles.container, ...style }}>
      <div style={styles.toolbar}>
        <span style={styles.fileName}>
          {displayName} <span style={styles.meta}>({lines.length} 行 · {fileType.toUpperCase()})</span>
        </span>
        <button type="button" onClick={handleCopy} style={styles.btn}>
          {copied ? '已复制 ✓' : '复制全文'}
        </button>
      </div>
      <div style={styles.codeHost}>
        <pre style={styles.pre}>
          <code>
            {lines.map((line, idx) => (
              <div key={idx} style={styles.line}>
                <span style={styles.lineNo}>{idx + 1}</span>
                <span style={styles.lineContent}>{line || ' '}</span>
              </div>
            ))}
          </code>
        </pre>
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
  btn: {
    padding: '4px 10px',
    border: '1px solid #cbd5e1',
    background: '#fff',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    color: '#334155',
  },
  codeHost: {
    flex: 1,
    overflow: 'auto',
    background: '#fafafa',
  },
  pre: {
    margin: 0,
    padding: '12px 0',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: '1.6',
  },
  line: {
    display: 'flex',
    padding: '0 12px',
  },
  lineNo: {
    userSelect: 'none',
    width: 40,
    minWidth: 40,
    color: '#94a3b8',
    textAlign: 'right',
    paddingRight: 16,
    fontSize: 12,
  },
  lineContent: {
    flex: 1,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: '#1e293b',
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
