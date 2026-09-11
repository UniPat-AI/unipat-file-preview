import React from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceUrl, inferFileName } from './utils.js';

export const FallbackPlugin: PreviewPlugin = {
  name: 'fallback',
  match: () => true, // 兜底匹配任意格式
  Component: FallbackComponent,
};

function FallbackComponent({ src, fileType, fileName, className, style }: PreviewPluginProps) {
  const { url } = useSourceUrl(src);
  const displayName = inferFileName(src, fileName);

  return (
    <div className={className} style={{ ...styles.container, ...style }}>
      <div style={styles.card}>
        <div style={styles.icon}>📄</div>
        <div style={styles.title}>{displayName}</div>
        <div style={styles.badge}>{fileType ? fileType.toUpperCase() : 'UNKNOWN'} 文件</div>
        <p style={styles.hint}>暂不支持直接在浏览器中内嵌预览该类型文件，您可以直接下载后查看。</p>
        {url ? (
          <a href={url} download={displayName} style={styles.downloadBtn}>
            下载文件
          </a>
        ) : null}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    height: '100%',
    minHeight: 350,
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: 24,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    maxWidth: 400,
    padding: 32,
    background: '#ffffff',
    borderRadius: 12,
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.05)',
    border: '1px solid #f1f5f9',
  },
  icon: {
    fontSize: 54,
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: '#1e293b',
    wordBreak: 'break-all',
    marginBottom: 8,
  },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    background: '#e2e8f0',
    color: '#475569',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    marginBottom: 12,
  },
  hint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 1.5,
    margin: '0 0 20px',
  },
  downloadBtn: {
    display: 'inline-block',
    padding: '8px 20px',
    background: '#2563eb',
    color: '#ffffff',
    borderRadius: 6,
    textDecoration: 'none',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 0.15s ease',
  },
};
