import { useEffect, useState } from 'react';
import {
  normalizePreviewError,
  PreviewError,
  type PreviewClient,
} from './contracts/index.js';
import type { ArtifactDescriptor } from './contracts/index.js';

export interface ViewerContext {
  readonly client: PreviewClient;
  readonly previewId: string;
  readonly publishedRevision: number;
  readonly artifact: ArtifactDescriptor;
  readonly manifestArtifacts?: readonly ArtifactDescriptor[];
}

export function TextViewer({
  client,
  previewId,
  publishedRevision,
  artifact,
}: ViewerContext) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<PreviewError | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    async function load() {
      try {
        const buf = await client.fetchArtifact({
          previewId,
          publishedRevision,
          artifactId: artifact.artifactId,
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        const decoded = new TextDecoder('utf-8').decode(new Uint8Array(buf));
        if (artifact.mediaType.includes('json') || artifact.artifactId === 'entry') {
          try {
            const indexJson = JSON.parse(decoded) as { chunk_ids?: string[] };
            if (Array.isArray(indexJson.chunk_ids) && indexJson.chunk_ids.length > 0) {
              const parts: string[] = [];
              for (const chunkId of indexJson.chunk_ids) {
                const chunkBuf = await client.fetchArtifact({
                  previewId,
                  publishedRevision,
                  artifactId: chunkId,
                  signal: ac.signal,
                });
                parts.push(new TextDecoder('utf-8').decode(new Uint8Array(chunkBuf)));
              }
              if (!ac.signal.aborted) {
                setText(parts.join(''));
              }
              return;
            }
          } catch {
            // not index json, fallback to raw text
          }
        }
        setText(decoded);
      } catch (e: unknown) {
        if (!ac.signal.aborted) setErr(normalizePreviewError(e));
      }
    }
    void load();
    return () => ac.abort();
  }, [client, previewId, publishedRevision, artifact.artifactId, artifact.mediaType]);

  if (err) {
    return (
      <pre
        role='alert'
        style={styles.errorBox}
      >
        {err.code}: {err.message}
      </pre>
    );
  }
  if (text === null) {
    return <div style={styles.skeleton}>Loading text…</div>;
  }
  return <pre style={styles.textBox}>{text}</pre>;
}

export function UnsupportedViewer({ artifact }: ViewerContext) {
  return (
    <div style={styles.placeholderBox}>
      <p style={styles.placeholderTitle}>Unsupported representation</p>
      <p style={styles.placeholderHint}>
        media_type: <code>{artifact.mediaType}</code>
      </p>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  errorBox: {
    padding: 12,
    background: '#fdecea',
    color: '#611a15',
    borderRadius: 6,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
  },
  skeleton: {
    padding: 12,
    color: '#666',
    fontStyle: 'italic',
  },
  textBox: {
    padding: 12,
    background: '#f6f8fa',
    borderRadius: 6,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.5,
  },
  placeholderBox: {
    padding: 16,
    border: '1px dashed #cbd5e0',
    borderRadius: 8,
    color: '#4a5568',
  },
  placeholderTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
  },
  placeholderHint: {
    margin: '4px 0 0',
    fontSize: 12,
    color: '#718096',
  },
};
