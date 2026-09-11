import { ERROR_CODES, type PreviewErrorPayload } from './types.js';

export class PreviewError extends Error implements PreviewErrorPayload {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly requestId?: string;

  constructor(payload: PreviewErrorPayload) {
    super(payload.message);
    this.name = 'PreviewError';
    this.code = payload.code;
    this.retryable = payload.retryable;
    if (payload.httpStatus !== undefined) this.httpStatus = payload.httpStatus;
    if (payload.requestId !== undefined) this.requestId = payload.requestId;
  }
}

export function normalizePreviewError(err: unknown): PreviewError {
  if (err instanceof PreviewError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return new PreviewError({
        code: ERROR_CODES.REQUEST_ABORTED,
        message: '请求已被取消',
        retryable: false,
      });
    }
    return new PreviewError({
      code: (err as { code?: string }).code ?? ERROR_CODES.UNKNOWN_ERROR,
      message: err.message,
      retryable: false,
    });
  }
  return new PreviewError({
    code: ERROR_CODES.UNKNOWN_ERROR,
    message: String(err),
    retryable: false,
  });
}

export interface TargetPreviewInput {
  readonly previewId: string;
  readonly signal?: AbortSignal;
}

export interface PreviewEventSubscription {
  close(): void;
}

export function subscribePreviewEvents(options: {
  baseUrl: string;
  basePath?: string;
  previewId: string;
  lastEventId?: number;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  onEvent: (event: import('./types.js').PreviewEventEnvelope) => void;
  onError?: (err: Error) => void;
  onOpen?: () => void;
}): PreviewEventSubscription {
  if (typeof EventSource === 'undefined') {
    return { close() {} };
  }
  const basePath = options.basePath ?? '/api/file-preview/v1';
  const url = `${options.baseUrl.replace(/\/+$/, '')}${basePath}/previews/${encodeURIComponent(options.previewId)}/events`;
  const es = new EventSource(url);
  es.onopen = () => options.onOpen?.();
  es.onerror = () => options.onError?.(new Error('SSE 连接失败'));
  es.addEventListener('preview-state', (e) => {
    try {
      const data = JSON.parse(e.data);
      options.onEvent({
        eventId: Number(e.lastEventId || 0),
        previewId: options.previewId,
        type: 'preview-state',
        state: data,
        emittedAt: new Date().toISOString(),
      });
    } catch {
      // ignore
    }
  });
  return {
    close() {
      es.close();
    },
  };
}

export interface PreviewClient {
  readonly protocolVersion?: string;
  getState(input: {
    file: { resourceKey: string; version: string };
    profileId?: string;
    signal?: AbortSignal;
  }): Promise<import('./types.js').PreviewState>;
  requestGenerate(input: {
    file: { resourceKey: string; version: string };
    profileId?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<import('./types.js').PreviewState>;
  cancel(input: TargetPreviewInput): Promise<import('./types.js').PreviewState>;
  retry(input: TargetPreviewInput & { readonly idempotencyKey?: string }): Promise<import('./types.js').PreviewState>;
  clear(input: TargetPreviewInput): Promise<void>;
  fetchManifest(input: {
    previewId: string;
    publishedRevision: number;
    etag?: string;
    signal?: AbortSignal;
  }): Promise<import('./types.js').Manifest>;
  fetchArtifact(input: {
    previewId: string;
    publishedRevision: number;
    artifactId: string;
    etag?: string;
    range?: { start: number; endInclusive: number };
    signal?: AbortSignal;
  }): Promise<ArrayBuffer>;
  fetchSheetWindow(input: {
    previewId: string;
    range: {
      publishedRevision: number;
      sheetId: string;
      rowStart: number;
      rowEnd: number;
      colStart: number;
      colEnd: number;
    };
    signal?: AbortSignal;
  }): Promise<import('./types.js').SheetWindow>;
}
