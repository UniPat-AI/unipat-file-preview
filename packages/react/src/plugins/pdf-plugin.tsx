import React, { useState } from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceUrl, inferFileName } from './utils.js';

export const PdfPlugin: PreviewPlugin = {
  name: 'pdf',
  match: (fileType) => fileType === 'pdf',
  Component: PdfComponent,
};

function PdfComponent({ src, className, style, onLoad, onError, fileName }: PreviewPluginProps) {
  const { url, error } = useSourceUrl(src);
  const [fullscreen, setFullscreen] = useState(false);
  const displayName = inferFileName(src, fileName);

  if (error) {
    onError?.(error);
    return <div style={styles.errorBox}>PDF 加载失败：{error.message}</div>;
  }

  if (!url) {
    return <div style={styles.loading}>加载 PDF 中…</div>;
  }

  const openInNewTab = () => {
    window.open(url, '_blank');
  };

  // 移植自 GDPVal-V2 踩坑方案：追加标准 PDF 打开参数，默认不展开左侧缩略图/书签侧栏（保留工具栏）
  const viewerUrl = url.includes('#') ? url : `${url}#toolbar=1&navpanes=0&pagemode=none`;

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
        <div style={styles.actions}>
          <button type="button" onClick={openInNewTab} style={styles.btn}>
            在新标签页打开 ↗
          </button>
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            style={styles.btn}
          >
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
        </div>
      </div>
      <div style={styles.pdfHost}>
        <object
          data={viewerUrl}
          type="application/pdf"
          onLoad={() => onLoad?.()}
          style={styles.object}
        >
          <iframe
            src={viewerUrl}
            title={displayName}
            style={styles.object}
            onLoad={() => onLoad?.()}
          >
            <div style={styles.fallbackNotice}>
              <p>当前浏览器不支持直接内嵌显示 PDF 文件。</p>
              <a href={url} target="_blank" rel="noreferrer" style={styles.downloadLink}>
                点击此处下载并查看文件
              </a>
            </div>
          </iframe>
        </object>
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
    minHeight: 500,
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
  actions: {
    display: 'flex',
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
  pdfHost: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  object: {
    width: '100%',
    height: '100%',
    minHeight: 500,
    border: 'none',
  },
  fallbackNotice: {
    padding: 32,
    textAlign: 'center',
    color: '#64748b',
  },
  downloadLink: {
    color: '#2563eb',
    textDecoration: 'underline',
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
