import React, { useMemo } from 'react';
import type {
  ArtifactDescriptor,
  FileRef,
  Manifest,
  PreviewState,
  Representation,
} from './contracts/index.js';
import { ERROR_CODES } from './contracts/index.js';
import type { PreviewClient, PreviewError } from './contracts/index.js';
import { usePreview, useManifest } from './hooks/use-preview.js';
import {
  TextViewer,
  UnsupportedViewer,
  type ViewerContext,
} from './viewers.js';
import { PdfViewer } from './pdf-viewer.js';
import { TableViewer } from './table-viewer.js';
import { GalleryViewer } from './gallery-viewer.js';
import { HtmlViewer } from './html-viewer.js';
import { NotebookViewer } from './notebook-viewer.js';
import type { FileSource, PreviewPlugin } from './plugins/types.js';
import { DEFAULT_PLUGINS } from './plugins/default-plugins.js';
import { inferFileType } from './plugins/utils.js';

// ============================================================
// 开箱即用模式入参（纯前端，直传 src）
// ============================================================
export interface DirectFilePreviewProps {
  /** 文件来源：网络 URL 字符串、本地 File 对象、或 Blob 对象 */
  readonly src: FileSource;
  /** 文件格式（小写，不含点，如 'pdf', 'csv', 'png'）；未指定时自动根据 URL 或文件名推导 */
  readonly fileType?: string;
  /** 文件名（用于展示与下载提示） */
  readonly fileName?: string;
  /** 插件扩展列表：自定义插件会优先于内置插件进行匹配 */
  readonly plugins?: readonly PreviewPlugin[];
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly onLoad?: () => void;
  readonly onError?: (error: Error) => void;
}

// ============================================================
// 微服务调度模式入参（基于已有后端转码中台协议）
// ============================================================
export interface ServiceFilePreviewProps {
  readonly client: PreviewClient;
  readonly file: FileRef;
  readonly profileId?: string;
  readonly idempotencyKey?: string;
  readonly autoGenerate?: boolean;
  readonly pollIntervalMs?: number;
  readonly renderLoading?: (state: PreviewState | null) => React.ReactNode;
  readonly renderError?: (error: PreviewError) => React.ReactNode;
  readonly renderEmpty?: () => React.ReactNode;
}

export type FilePreviewProps = DirectFilePreviewProps | ServiceFilePreviewProps;

/**
 * 通用文件预览组件
 * - 开箱即用模式：`<FilePreview src="https://.../doc.pdf" />`
 * - 微服务中台模式：`<FilePreview client={client} file={fileRef} />`
 */
export function FilePreview(props: FilePreviewProps) {
  if ('src' in props) {
    return <DirectFilePreview {...props} />;
  }
  return <ServiceFilePreview {...props} />;
}

// ------------------------------------------------------------
// 纯前端开箱即用插件分发实现
// ------------------------------------------------------------
function DirectFilePreview(props: DirectFilePreviewProps) {
  const {
    src,
    fileType: explicitType,
    fileName,
    plugins: customPlugins,
    className,
    style,
    onLoad,
    onError,
  } = props;

  const fileType = useMemo(
    () => inferFileType(src, explicitType, fileName),
    [src, explicitType, fileName],
  );

  const matchedPlugin = useMemo(() => {
    const pool = [...(customPlugins ?? []), ...DEFAULT_PLUGINS];
    return pool.find((p) => p.match(fileType, src)) ?? DEFAULT_PLUGINS[DEFAULT_PLUGINS.length - 1]!;
  }, [fileType, src, customPlugins]);

  const Component = matchedPlugin.Component;

  return (
    <Component
      src={src}
      fileType={fileType}
      fileName={fileName}
      className={className}
      style={style}
      onLoad={onLoad}
      onError={onError}
    />
  );
}

// ------------------------------------------------------------
// 微服务调度预览实现（向后兼容已有架构）
// ------------------------------------------------------------
function ServiceFilePreview(props: ServiceFilePreviewProps) {
  const {
    client,
    file,
    renderLoading,
    renderError,
    renderEmpty,
    ...previewOpts
  } = props;

  const preview = usePreview({ client, file, ...previewOpts });
  const {
    manifest,
    error: manifestError,
    loading: manifestLoading,
  } = useManifest(client, preview.state);

  if (preview.phase === 'error' && preview.error) {
    return renderError ? (
      <>{renderError(preview.error)}</>
    ) : (
      <DefaultErrorView
        error={preview.error}
        onRetry={preview.retry ?? preview.refresh}
      />
    );
  }

  if (manifestError) {
    return renderError ? (
      <>{renderError(manifestError)}</>
    ) : (
      <DefaultErrorView
        error={manifestError}
        onRetry={preview.retry ?? preview.refresh}
      />
    );
  }

  const combinedLoading =
    preview.phase === 'idle' ||
    preview.phase === 'loading' ||
    preview.phase === 'polling' ||
    manifestLoading;

  if (combinedLoading || !manifest) {
    return renderLoading ? (
      <>{renderLoading(preview.state)}</>
    ) : (
      <DefaultLoadingView state={preview.state} />
    );
  }

  const { representation, artifact } = pickEntry(manifest);
  if (!representation || !artifact) {
    return renderEmpty ? <>{renderEmpty()}</> : <DefaultEmptyView />;
  }

  const ctx: ViewerContext = {
    client,
    previewId: manifest.previewId,
    publishedRevision: manifest.publishedRevision,
    artifact,
    manifestArtifacts: manifest.artifacts,
  };

  return (
    <ViewerDispatch
      representation={representation}
      ctx={ctx}
    />
  );
}

function ViewerDispatch({
  representation,
  ctx,
}: {
  representation: Representation;
  ctx: ViewerContext;
}) {
  const kind = String(representation.kind);
  switch (kind) {
    case 'text':
    case 'plain_text':
    case 'structured_text':
      return <TextViewer {...ctx} />;
    case 'pdf':
      return <PdfViewer {...ctx} />;
    case 'table':
      return <TableViewer {...ctx} />;
    case 'gallery':
    case 'image_gallery':
    case 'image':
      return <GalleryViewer {...ctx} />;
    case 'html':
      return <HtmlViewer {...ctx} />;
    case 'notebook':
      return <NotebookViewer {...ctx} />;
    default:
      return <UnsupportedViewer {...ctx} />;
  }
}

function pickEntry(manifest: Manifest): {
  representation: Representation | null;
  artifact: ArtifactDescriptor | null;
} {
  const rep =
    manifest.representations.find(
      (r) => r.id === manifest.defaultRepresentationId,
    ) ?? manifest.representations[0];
  if (!rep) return { representation: null, artifact: null };
  const entryId = rep.entryArtifactId;
  const artifact = entryId
    ? (manifest.artifacts.find((a) => a.artifactId === entryId) ?? null)
    : null;
  return { representation: rep, artifact };
}

function DefaultLoadingView({ state }: { state: PreviewState | null }) {
  const stage = state?.stage ?? 'queued';
  return (
    <div
      role='status'
      aria-live='polite'
      style={{
        padding: 16,
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        color: '#4a5568',
        fontSize: 13,
      }}
    >
      Preparing preview… <code>{stage}</code>
    </div>
  );
}

function DefaultErrorView({
  error,
  onRetry,
}: {
  error: PreviewError;
  onRetry?: () => void;
}) {
  const canRetry =
    error.retryable ||
    error.code === ERROR_CODES.IDEMPOTENCY_CONFLICT ||
    error.code === ERROR_CODES.SERVICE_UNAVAILABLE ||
    error.code === ERROR_CODES.NETWORK_ERROR;
  return (
    <div
      role='alert'
      style={{
        padding: 16,
        border: '1px solid #fed7d7',
        borderRadius: 8,
        background: '#fff5f5',
        color: '#9b2c2c',
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {error.code}
        {error.requestId ? (
          <span
            style={{
              fontWeight: 400,
              fontSize: 11,
              marginLeft: 8,
              color: '#718096',
            }}
          >
            req: {error.requestId}
          </span>
        ) : null}
      </div>
      <div>{error.message}</div>
      {canRetry && onRetry ? (
        <button
          type='button'
          onClick={onRetry}
          style={{
            marginTop: 8,
            padding: '4px 12px',
            border: '1px solid #cbd5e0',
            borderRadius: 4,
            background: '#fff',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function DefaultEmptyView() {
  return (
    <div
      style={{
        padding: 16,
        border: '1px dashed #cbd5e0',
        borderRadius: 8,
        color: '#718096',
        fontSize: 13,
      }}
    >
      No preview representation available.
    </div>
  );
}
