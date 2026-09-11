import { useEffect, useRef, useState } from 'react';
import {
  normalizePreviewError,
  PreviewError,
  type PreviewClient,
} from './contracts/index.js';
import type { ArtifactDescriptor } from './contracts/index.js';
import type { ViewerContext } from './viewers.js';

type PdfJsModule = typeof import('pdfjs-dist');
type PdfDocument = Awaited<ReturnType<PdfJsModule['getDocument']>['promise']>;

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (pdfjsModulePromise) return pdfjsModulePromise;
  pdfjsModulePromise = (async () => {
    const mod = (await import('pdfjs-dist')) as unknown as PdfJsModule;
    // 用 pdfjs-dist 自带的 worker（ESM）。构建工具会把它作为 module 处理。
    const workerUrl = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    return mod;
  })();
  return pdfjsModulePromise;
}

export function PdfViewer({
  client,
  previewId,
  publishedRevision,
  artifact,
}: ViewerContext) {
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<PreviewError | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<PdfDocument | null>(null);
  const renderTokenRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    setPageCount(0);

    (async () => {
      try {
        const [pdfjs, buffer] = await Promise.all([
          loadPdfJs(),
          client.fetchArtifact({
            previewId,
            publishedRevision,
            artifactId: artifact.artifactId,
            signal: ac.signal,
          }),
        ]);
        if (cancelled || ac.signal.aborted) return;
        const loadingTask = pdfjs.getDocument({
          data: new Uint8Array(buffer),
        });
        const doc = await loadingTask.promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current?.destroy().catch(() => undefined);
        docRef.current = doc;
        setPageCount(doc.numPages);
        setLoading(false);
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setError(normalizePreviewError(err));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      docRef.current?.destroy().catch(() => undefined);
      docRef.current = null;
    };
  }, [client, previewId, publishedRevision, artifact.artifactId]);

  useEffect(() => {
    const host = canvasHostRef.current;
    const doc = docRef.current;
    if (!host || !doc || pageCount === 0) return;

    const token = ++renderTokenRef.current;
    host.innerHTML = '';

    (async () => {
      for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
        if (renderTokenRef.current !== token) return;
        try {
          const page = await doc.getPage(pageNum);
          const viewport = page.getViewport({ scale: zoom * dpr() });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = `${viewport.width / dpr()}px`;
          canvas.style.height = `${viewport.height / dpr()}px`;
          canvas.style.display = 'block';
          canvas.style.margin = '0 auto 12px';
          canvas.style.boxShadow = '0 1px 3px rgba(0,0,0,0.15)';
          canvas.style.background = '#fff';
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          host.appendChild(canvas);
          await page.render({ canvasContext: ctx, viewport }).promise;
        } catch (err) {
          if (renderTokenRef.current !== token) return;
          setError(normalizePreviewError(err));
          return;
        }
      }
    })();
  }, [pageCount, zoom]);

  if (error) {
    return (
      <pre role="alert" style={styles.errorBox}>
        {error.code}: {error.message}
      </pre>
    );
  }

  const onZoomIn = () =>
    setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)));
  const onZoomOut = () =>
    setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)));
  const onZoomReset = () => setZoom(1);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (loading) return;
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      onZoomIn();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      onZoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      onZoomReset();
    }
  };

  return (
    <div
      style={styles.wrapper}
      role="region"
      aria-label="PDF 预览"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div style={styles.toolbar}>
        <span style={styles.meta} aria-live="polite">
          {loading ? 'Loading PDF…' : `${pageCount} pages`}
        </span>
        <div style={styles.zoomGroup}>
          <button
            type="button"
            onClick={onZoomOut}
            style={styles.zoomBtn}
            disabled={loading}
            aria-label="缩小 (快捷键 -)"
          >
            −
          </button>
          <span style={styles.zoomLabel} aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={onZoomIn}
            style={styles.zoomBtn}
            disabled={loading}
            aria-label="放大 (快捷键 +)"
          >
            +
          </button>
          <button
            type="button"
            onClick={onZoomReset}
            style={styles.zoomBtn}
            disabled={loading}
            aria-label="重置缩放 (快捷键 0)"
          >
            ↺
          </button>
        </div>
      </div>
      <div
        ref={canvasHostRef}
        style={{
          maxHeight: 640,
          overflow: 'auto',
          background: '#edf2f7',
          padding: 12,
          borderRadius: 6,
        }}
      />
    </div>
  );
}

function dpr(): number {
  if (typeof window === 'undefined') return 1;
  return Math.max(1, window.devicePixelRatio || 1);
}

// silence unused
export type { ArtifactDescriptor };

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
    background: '#f7fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    fontSize: 12,
    color: '#4a5568',
  },
  meta: { fontFamily: 'monospace' },
  zoomGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  zoomBtn: {
    width: 24,
    height: 24,
    border: '1px solid #cbd5e0',
    background: '#fff',
    borderRadius: 4,
    cursor: 'pointer',
    lineHeight: 1,
  },
  zoomLabel: { minWidth: 42, textAlign: 'center', fontFamily: 'monospace' },
  errorBox: {
    padding: 12,
    background: '#fdecea',
    color: '#611a15',
    borderRadius: 6,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
  },
};
