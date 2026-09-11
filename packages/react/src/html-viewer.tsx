import { useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizePreviewError,
  PreviewError,
} from './contracts/index.js';
import type { ViewerContext } from './viewers.js';

export function HtmlViewer({
  client,
  previewId,
  publishedRevision,
  artifact,
}: ViewerContext) {
  const [htmlDoc, setHtmlDoc] = useState<string | null>(null);
  const [err, setErr] = useState<PreviewError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setHtmlDoc(null);
    setErr(null);
    client
      .fetchArtifact({
        previewId,
        publishedRevision,
        artifactId: artifact.artifactId,
        signal: ac.signal,
      })
      .then((buf) => {
        if (ac.signal.aborted) return;
        const decoded = new TextDecoder('utf-8').decode(new Uint8Array(buf));
        setHtmlDoc(decoded);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setErr(normalizePreviewError(e));
      });
    return () => {
      ac.abort();
    };
  }, [
    client,
    previewId,
    publishedRevision,
    artifact.artifactId,
    reloadKey,
  ]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        setFullscreen((v) => !v);
      } else if (e.key === 'Escape') {
        if (fullscreen) {
          e.preventDefault();
          setFullscreen(false);
        }
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setReloadKey((k) => k + 1);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const wrapStyle = useMemo<React.CSSProperties>(
    () =>
      fullscreen
        ? {
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: '#fff',
            display: 'flex',
            flexDirection: 'column',
          }
        : { display: 'flex', flexDirection: 'column', gap: 8 },
    [fullscreen],
  );

  if (err) {
    return (
      <pre role='alert' style={styles.errorBox}>
        {err.code}: {err.message}
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role='region'
      aria-label='HTML 预览'
      style={wrapStyle}
    >
      <div style={styles.toolbar}>
        <span style={styles.hint}>
          按键：<kbd>F</kbd> 全屏 · <kbd>Esc</kbd> 退出 · <kbd>R</kbd> 刷新
        </span>
        <span style={{ flex: 1 }} />
        <button
          type='button'
          onClick={() => setReloadKey((k) => k + 1)}
          style={styles.btn}
          aria-label='刷新'
        >
          Reload
        </button>
        <button
          type='button'
          onClick={() => setFullscreen((v) => !v)}
          style={styles.btn}
          aria-pressed={fullscreen}
        >
          {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </div>
      {htmlDoc ? (
        <iframe
          ref={iframeRef}
          title='HTML preview'
          srcDoc={htmlDoc}
          sandbox=''
          referrerPolicy='no-referrer'
          style={fullscreen ? styles.iframeFull : styles.iframe}
        />
      ) : (
        <div style={styles.skeleton}>Loading HTML…</div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 6,
    borderBottom: '1px solid #e2e8f0',
    fontSize: 12,
    color: '#4a5568',
  },
  hint: {
    color: '#718096',
  },
  btn: {
    padding: '2px 8px',
    border: '1px solid #cbd5e0',
    background: '#fff',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  iframe: {
    width: '100%',
    height: 480,
    border: '1px solid #e2e8f0',
    borderRadius: 4,
    background: '#fff',
  },
  iframeFull: {
    flex: 1,
    width: '100%',
    border: 'none',
    background: '#fff',
  },
  skeleton: {
    padding: 12,
    color: '#666',
    fontStyle: 'italic',
  },
  errorBox: {
    padding: 12,
    background: '#fdecea',
    color: '#611a15',
    borderRadius: 6,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
  },
};
