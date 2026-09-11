import React, { useState } from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceUrl, inferFileName } from './utils.js';

export const ImagePlugin: PreviewPlugin = {
  name: 'image',
  match: (fileType) =>
    ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(fileType),
  Component: ImageComponent,
};

function ImageComponent({ src, className, style, onLoad, onError, fileName }: PreviewPluginProps) {
  const { url, error } = useSourceUrl(src);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  const displayName = inferFileName(src, fileName);

  React.useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);

  React.useEffect(() => {
    setZoom(1);
    setRotation(0);
  }, [src]);

  if (error) {
    return <div style={styles.errorBox}>图片加载失败：{error.message}</div>;
  }

  if (!url) {
    return <div style={styles.loading}>加载中…</div>;
  }

  const zoomIn = () => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)));
  const rotateRight = () => setRotation((r) => (r + 90) % 360);
  const reset = () => {
    setZoom(1);
    setRotation(0);
  };

  return (
    <div className={className} style={{ ...styles.container, ...style }}>
      <div style={styles.toolbar}>
        <span style={styles.fileName}>{displayName}</span>
        <div style={styles.actions}>
          <button type="button" onClick={zoomOut} style={styles.btn} title="缩小 (-)">
            -
          </button>
          <span style={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={zoomIn} style={styles.btn} title="放大 (+)">
            +
          </button>
          <button type="button" onClick={rotateRight} style={styles.btn} title="顺时针旋转 90°">
            ↻
          </button>
          <button type="button" onClick={reset} style={styles.btn} title="复位">
            复位
          </button>
        </div>
      </div>
      <div style={styles.imageHost}>
        <img
          src={url}
          alt={displayName}
          onLoad={() => onLoad?.()}
          onError={(e) => {
            const err = new Error('图片资源加载失败');
            onError?.(err);
          }}
          style={{
            ...styles.image,
            transform: `scale(${zoom}) rotate(${rotation}deg)`,
          }}
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
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    background: '#fff',
    borderBottom: '1px solid #e2e8f0',
    fontSize: 13,
  },
  fileName: {
    fontWeight: 500,
    color: '#334155',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '50%',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  btn: {
    padding: '4px 10px',
    border: '1px solid #cbd5e1',
    background: '#f8fafc',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  zoomLabel: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#64748b',
    minWidth: 42,
    textAlign: 'center',
  },
  imageHost: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'auto',
    padding: 16,
  },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    transition: 'transform 0.15s ease-out',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
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
