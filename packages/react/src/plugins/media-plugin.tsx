import React from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceUrl, inferFileName } from './utils.js';

export const MediaPlugin: PreviewPlugin = {
  name: 'media',
  match: (fileType) =>
    ['mp4', 'webm', 'ogg', 'mp3', 'wav', 'aac', 'm4a', 'flac'].includes(fileType),
  Component: MediaComponent,
};

function MediaComponent({
  src,
  fileType,
  fileName,
  className,
  style,
  allowDownload = true,
  onLoad,
  onError,
}: PreviewPluginProps) {
  const { url, error } = useSourceUrl(src);
  const displayName = inferFileName(src, fileName);
  const isVideo = ['mp4', 'webm', 'ogg'].includes(fileType);

  React.useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);

  if (error) {
    return <div style={styles.errorBox}>媒体加载失败：{error.message}</div>;
  }

  if (!url) {
    return <div style={styles.loading}>加载中…</div>;
  }

  return (
    <div className={className} style={{ ...styles.container, ...style }}>
      <div style={styles.toolbar}>
        <span style={styles.fileName}>{displayName}</span>
        <span style={styles.meta}>{fileType.toUpperCase()}</span>
      </div>
      <div style={styles.mediaHost}>
        {isVideo ? (
          <video
            src={url}
            controls
            controlsList={allowDownload ? undefined : 'nodownload'}
            autoPlay={false}
            onLoadedData={() => onLoad?.()}
            onError={() => onError?.(new Error('视频解码或播放失败'))}
            style={styles.video}
          />
        ) : (
          <div style={styles.audioWrapper}>
            <div style={styles.audioIcon}>🎵</div>
            <audio
              src={url}
              controls
              controlsList={allowDownload ? undefined : 'nodownload'}
              autoPlay={false}
              onLoadedData={() => onLoad?.()}
              onError={() => onError?.(new Error('音频解码或播放失败'))}
              style={styles.audio}
            />
          </div>
        )}
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
    minHeight: 300,
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: 8,
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    background: '#1e293b',
    borderBottom: '1px solid #334155',
    fontSize: 13,
  },
  fileName: {
    fontWeight: 500,
    color: '#f8fafc',
  },
  meta: {
    color: '#94a3b8',
    fontSize: 12,
  },
  mediaHost: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  video: {
    maxWidth: '100%',
    maxHeight: '100%',
    borderRadius: 4,
    outline: 'none',
  },
  audioWrapper: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
    padding: 32,
    background: '#1e293b',
    borderRadius: 12,
  },
  audioIcon: {
    fontSize: 48,
  },
  audio: {
    outline: 'none',
  },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: 200,
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
