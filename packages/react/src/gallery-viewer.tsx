import { useEffect, useMemo, useState } from 'react';
import type { ArtifactDescriptor } from './contracts/index.js';
import {
  normalizePreviewError,
  PreviewError,
  type PreviewClient,
} from './contracts/index.js';
import type { ViewerContext } from './viewers.js';

const IMAGE_MEDIA_PREFIX = 'image/';

export function GalleryViewer({
  client,
  previewId,
  publishedRevision,
  artifact,
  manifestArtifacts,
}: ViewerContext) {
  // 从 manifest 里挑 image/* 的 artifact（排除 thumbnail 缩略图）；若只有 entry 一张，就退化为单图
  const images = useMemo(() => {
    const pool =
      manifestArtifacts && manifestArtifacts.length > 0
        ? manifestArtifacts.filter(
            (a) =>
              a.mediaType.startsWith(IMAGE_MEDIA_PREFIX) &&
              (a as { role?: string }).role !== 'thumbnail',
          )
        : [];
    if (pool.length > 0) return pool;
    return artifact.mediaType.startsWith(IMAGE_MEDIA_PREFIX) ? [artifact] : [];
  }, [manifestArtifacts, artifact]);

  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    setIndex(0);
  }, [images.length]);

  const current = images[index];

  if (!current) {
    return (
      <div style={styles.emptyBox}>
        No image artifact in this representation.
      </div>
    );
  }

  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(images.length - 1, i + 1));
  const zoomIn = () => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)));
  const zoomReset = () => setZoom(1);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goPrev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      goNext();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomIn();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      zoomReset();
    }
  };

  return (
    <div
      style={styles.wrapper}
      role='region'
      aria-label='图片预览'
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div style={styles.toolbar}>
        <button
          type='button'
          style={styles.navBtn}
          disabled={index === 0}
          onClick={goPrev}
          aria-label='上一张 (←)'
        >
          ← prev
        </button>
        <span
          style={styles.meta}
          aria-live='polite'
        >
          {index + 1} / {images.length} · {current.mediaType}
        </span>
        <button
          type='button'
          style={styles.navBtn}
          disabled={index >= images.length - 1}
          onClick={goNext}
          aria-label='下一张 (→)'
        >
          next →
        </button>
        <div style={styles.zoomGroup}>
          <button
            type='button'
            onClick={zoomOut}
            style={styles.zoomBtn}
            aria-label='缩小 (-)'
          >
            −
          </button>
          <span
            style={styles.zoomLabel}
            aria-live='polite'
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            type='button'
            onClick={zoomIn}
            style={styles.zoomBtn}
            aria-label='放大 (+)'
          >
            +
          </button>
          <button
            type='button'
            onClick={zoomReset}
            style={styles.zoomBtn}
            aria-label='重置缩放 (0)'
          >
            ↺
          </button>
        </div>
      </div>

      <ImageCanvas
        client={client}
        previewId={previewId}
        publishedRevision={publishedRevision}
        artifact={current}
        zoom={zoom}
      />

      {images.length > 1 ? (
        <div
          style={styles.strip}
          role='tablist'
          aria-label='图片缩略图'
        >
          {images.map((img, i) => (
            <Thumbnail
              key={img.artifactId}
              client={client}
              previewId={previewId}
              publishedRevision={publishedRevision}
              artifact={img}
              active={i === index}
              index={i}
              total={images.length}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ImageCanvas({
  client,
  previewId,
  publishedRevision,
  artifact,
  zoom,
}: {
  client: PreviewClient;
  previewId: string;
  publishedRevision: number;
  artifact: ArtifactDescriptor;
  zoom: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let objectUrl: string | null = null;
    client
      .fetchArtifact({
        previewId,
        publishedRevision,
        artifactId: artifact.artifactId,
        signal: ac.signal,
      })
      .then((buf) => {
        if (ac.signal.aborted) return;
        const blob = new Blob([buf], { type: artifact.mediaType });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(normalizePreviewError(err));
      });
    return () => {
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    client,
    previewId,
    publishedRevision,
    artifact.artifactId,
    artifact.mediaType,
  ]);

  if (error) {
    return (
      <pre
        style={styles.errorBox}
        role='alert'
      >
        {error.code}: {error.message}
      </pre>
    );
  }
  if (!url) return <div style={styles.skeleton}>Loading image…</div>;
  return (
    <div style={styles.canvasHost}>
      <img
        src={url}
        alt={artifact.artifactId}
        style={{
          transform: `scale(${zoom})`,
          transformOrigin: 'top left',
          maxWidth: 'none',
          display: 'block',
        }}
      />
    </div>
  );
}

function Thumbnail({
  client,
  previewId,
  publishedRevision,
  artifact,
  active,
  index,
  total,
  onClick,
}: {
  client: PreviewClient;
  previewId: string;
  publishedRevision: number;
  artifact: ArtifactDescriptor;
  active: boolean;
  index: number;
  total: number;
  onClick: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    let objectUrl: string | null = null;
    client
      .fetchArtifact({
        previewId,
        publishedRevision,
        artifactId: artifact.artifactId,
        signal: ac.signal,
      })
      .then((buf) => {
        if (ac.signal.aborted) return;
        const blob = new Blob([buf], { type: artifact.mediaType });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    client,
    previewId,
    publishedRevision,
    artifact.artifactId,
    artifact.mediaType,
  ]);

  return (
    <button
      type='button'
      onClick={onClick}
      role='tab'
      aria-selected={active}
      aria-label={`第 ${index + 1} / ${total} 张`}
      style={{
        ...styles.thumbBtn,
        borderColor: active ? '#3182ce' : '#cbd5e0',
        boxShadow: active ? '0 0 0 2px rgba(49,130,206,0.2)' : 'none',
      }}
    >
      {url ? (
        <img
          src={url}
          alt=''
          style={styles.thumbImg}
        />
      ) : (
        <div style={styles.thumbSkeleton} />
      )}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { display: 'flex', flexDirection: 'column', gap: 8 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px',
    background: '#f7fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    fontSize: 12,
    color: '#4a5568',
    flexWrap: 'wrap',
  },
  navBtn: {
    padding: '4px 8px',
    border: '1px solid #cbd5e0',
    background: '#fff',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  meta: { fontFamily: 'monospace' },
  zoomGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
  },
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
  canvasHost: {
    maxHeight: 560,
    overflow: 'auto',
    background: '#edf2f7',
    borderRadius: 6,
    padding: 8,
  },
  skeleton: { padding: 16, color: '#718096', fontStyle: 'italic' },
  errorBox: {
    padding: 12,
    background: '#fdecea',
    color: '#611a15',
    borderRadius: 6,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
  },
  emptyBox: {
    padding: 16,
    color: '#718096',
    border: '1px dashed #cbd5e0',
    borderRadius: 6,
    fontSize: 13,
  },
  strip: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    padding: 4,
  },
  thumbBtn: {
    padding: 0,
    background: 'transparent',
    border: '2px solid',
    borderRadius: 4,
    cursor: 'pointer',
    width: 72,
    height: 72,
    flexShrink: 0,
    overflow: 'hidden',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  thumbSkeleton: {
    width: '100%',
    height: '100%',
    background: 'linear-gradient(90deg, #edf2f7 0%, #e2e8f0 50%, #edf2f7 100%)',
  },
};
