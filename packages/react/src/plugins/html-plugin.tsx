import React, { useState } from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceText, inferFileName } from './utils.js';

export const HtmlPlugin: PreviewPlugin = {
  name: 'html',
  match: (fileType) => ['htm', 'html'].includes(fileType),
  Component: HtmlComponent,
};

function HtmlComponent({ src, className, style, onLoad, onError, fileName }: PreviewPluginProps) {
  const { text, loading, error } = useSourceText(src);
  const [fullscreen, setFullscreen] = useState(false);
  const displayName = inferFileName(src, fileName);

  if (error) {
    onError?.(error);
    return <div style={styles.errorBox}>HTML 加载失败：{error.message}</div>;
  }

  if (loading) {
    return <div style={styles.loading}>加载网页中…</div>;
  }

  return (
    <div
      className={className}
      style={{
        ...styles.container,
        ...(fullscreen ? styles.containerFull : {}),
        ...style,
      }}
    >
      <div style={styles.toolbar}>
        <span style={styles.fileName}>{displayName}</span>
        <button
          type="button"
          onClick={() => setFullscreen((v) => !v)}
          style={styles.btn}
        >
          {fullscreen ? '退出全屏' : '全屏'}
        </button>
      </div>
      <div style={styles.iframeWrapper}>
        <iframe
          title={displayName}
          srcDoc={text ?? ''}
          sandbox=""
          referrerPolicy="no-referrer"
          onLoad={() => onLoad?.()}
          style={styles.iframe}
        />
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
  containerFull: {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    zIndex: 99999,
    borderRadius: 0,
    border: 'none',
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
  btn: {
    padding: '4px 10px',
    border: '1px solid #cbd5e1',
    background: '#fff',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  iframeWrapper: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    background: '#fff',
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
