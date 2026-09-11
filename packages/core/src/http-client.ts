import type {
  FileRef,
  Manifest,
  PreviewState,
  SheetRange,
  SheetWindow,
} from './contracts.js';
import {
  DEFAULT_HTTP_BASE_PATH,
  DEFAULT_PROFILE_ID,
  HTTP_PROTOCOL_VERSION,
  IDEMPOTENCY_KEY_HEADER,
} from './contracts.js';
import {
  decodeManifest,
  decodePreviewState,
  decodeSheetWindow,
} from './decode.js';
import { deepCamelToSnake } from './case-mapping.js';
import { normalizePreviewError, PreviewError } from './errors.js';
import { ERROR_CODES } from './contracts.js';
import { RequestQueue } from './request-queue.js';
import {
  isFresh,
  parseMaxAgeMs,
  type ArtifactCache,
  type ArtifactCacheEntry,
} from './artifact-cache.js';

export interface PreviewClient {
  readonly protocolVersion: string;
  getState(input: GetStateInput): Promise<PreviewState>;
  requestGenerate(input: GenerateInput): Promise<PreviewState>;
  cancel(input: TargetPreviewInput): Promise<PreviewState>;
  retry(
    input: TargetPreviewInput & { readonly idempotencyKey?: string },
  ): Promise<PreviewState>;
  clear(input: TargetPreviewInput): Promise<void>;
  fetchManifest(input: FetchManifestInput): Promise<Manifest>;
  fetchArtifact(input: FetchArtifactInput): Promise<ArrayBuffer>;
  fetchSheetWindow(input: FetchSheetWindowInput): Promise<SheetWindow>;
}

export interface GetStateInput {
  readonly file: FileRef;
  readonly profileId?: string;
  readonly signal?: AbortSignal;
}

export interface GenerateInput extends GetStateInput {
  readonly idempotencyKey: string;
}

export interface TargetPreviewInput {
  readonly previewId: string;
  readonly signal?: AbortSignal;
}

export interface FetchManifestInput {
  readonly previewId: string;
  readonly publishedRevision: number;
  readonly signal?: AbortSignal;
}

export interface FetchArtifactInput {
  readonly previewId: string;
  readonly publishedRevision: number;
  readonly artifactId: string;
  readonly signal?: AbortSignal;
  /**
   * 若显式提供，将作为 If-None-Match 使用；服务端返回 304 时会命中 `artifactCache`
   * 或抛出 `PROTOCOL_ERROR`（若没有本地缓存）。未提供时，客户端会自动使用
   * `artifactCache` 里已缓存条目的 etag。
   */
  readonly etag?: string;
}

export interface FetchSheetWindowInput {
  readonly previewId: string;
  readonly range: SheetRange;
  readonly signal?: AbortSignal;
}

export interface HttpPreviewClientOptions {
  readonly baseUrl: string;
  readonly basePath?: string;
  readonly fetch?: typeof fetch;
  readonly maxParallelRequests?: number;
  readonly headers?: () =>
    | Record<string, string>
    | Promise<Record<string, string>>;
  /**
   * 可选的 artifact 缓存。传入后 `fetchArtifact` 会自动：
   *  1) 使用本地新鲜条目直接返回（依赖 Cache-Control:max-age）；
   *  2) 过期时携带 If-None-Match，服务端返回 304 时复用本地条目；
   *  3) 200 时按响应头（ETag / Cache-Control / Content-Type）写回缓存。
   */
  readonly artifactCache?: ArtifactCache;
}

export function createHttpPreviewClient(
  options: HttpPreviewClientOptions,
): PreviewClient {
  const basePath = options.basePath ?? DEFAULT_HTTP_BASE_PATH;
  const httpFetch = options.fetch ?? globalThis.fetch;
  if (typeof httpFetch !== 'function') {
    throw new Error(
      'createHttpPreviewClient 需要在支持 fetch 的环境中运行，或显式传入 fetch',
    );
  }
  const queue = new RequestQueue({
    ...(options.maxParallelRequests !== undefined
      ? { maxParallel: options.maxParallelRequests }
      : {}),
  });

  const request = async <T>(
    method: string,
    path: string,
    init: {
      body?: unknown;
      query?: Record<string, string | number>;
      extraHeaders?: Record<string, string>;
      signal?: AbortSignal;
      decode: (raw: unknown) => T;
      expectBinary?: boolean;
    },
  ): Promise<T> => {
    return queue.enqueue(async () => {
      const url = new URL(joinPath(options.baseUrl, basePath, path));
      if (init.query) {
        for (const [k, v] of Object.entries(init.query)) {
          url.searchParams.set(k, String(v));
        }
      }

      const headers: Record<string, string> = {
        accept: init.expectBinary
          ? 'application/octet-stream'
          : 'application/json',
        'x-preview-protocol': HTTP_PROTOCOL_VERSION,
      };
      if (options.headers) {
        Object.assign(headers, await options.headers());
      }
      if (init.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      if (init.extraHeaders) Object.assign(headers, init.extraHeaders);

      let response: Response;
      try {
        const requestInit: RequestInit = {
          method,
          headers,
          ...(init.body !== undefined
            ? { body: JSON.stringify(deepCamelToSnake(init.body)) }
            : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        };
        response = await httpFetch(url.toString(), requestInit);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          throw normalizePreviewError(err);
        }
        throw new PreviewError({
          code: ERROR_CODES.NETWORK_ERROR,
          message: (err as Error)?.message ?? '网络错误',
          retryable: true,
        });
      }

      if (!response.ok) {
        const requestId = response.headers.get('x-request-id') ?? undefined;
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = { message: response.statusText };
        }
        throw normalizePreviewError(payload, requestId ? { requestId } : {});
      }

      if (init.expectBinary) {
        const buf = await response.arrayBuffer();
        return init.decode(buf);
      }

      if (response.status === 204) {
        return init.decode(undefined);
      }

      const json = await response.json();
      return init.decode(json);
    }, init.signal);
  };

  return {
    protocolVersion: HTTP_PROTOCOL_VERSION,

    getState({ file, profileId, signal }) {
      return request('GET', '/state', {
        query: {
          resource_key: file.resourceKey,
          version: file.version,
          profile_id: profileId ?? DEFAULT_PROFILE_ID,
        },
        ...(signal ? { signal } : {}),
        decode: decodePreviewState,
      });
    },

    requestGenerate({ file, profileId, idempotencyKey, signal }) {
      return request('POST', '/generate', {
        body: {
          fileRef: file,
          profileId: profileId ?? DEFAULT_PROFILE_ID,
        },
        extraHeaders: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        ...(signal ? { signal } : {}),
        decode: decodePreviewState,
      });
    },

    cancel({ previewId, signal }) {
      return request(
        'POST',
        `/previews/${encodeURIComponent(previewId)}/cancel`,
        {
          ...(signal ? { signal } : {}),
          decode: decodePreviewState,
        },
      );
    },

    retry({ previewId, idempotencyKey, signal }) {
      return request(
        'POST',
        `/previews/${encodeURIComponent(previewId)}/retry`,
        {
          ...(idempotencyKey
            ? { extraHeaders: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } }
            : {}),
          ...(signal ? { signal } : {}),
          decode: decodePreviewState,
        },
      );
    },

    async clear({ previewId, signal }) {
      await request(
        'POST',
        `/previews/${encodeURIComponent(previewId)}/clear`,
        {
          ...(signal ? { signal } : {}),
          decode: () => undefined,
        },
      );
    },

    fetchManifest({ previewId, publishedRevision, signal }) {
      return request(
        'GET',
        `/previews/${encodeURIComponent(previewId)}/revisions/${publishedRevision}/manifest`,
        {
          ...(signal ? { signal } : {}),
          decode: decodeManifest,
        },
      );
    },

    fetchArtifact({ previewId, publishedRevision, artifactId, signal, etag }) {
      const cache = options.artifactCache;
      const cacheKey = `artifact|${previewId}|${publishedRevision}|${artifactId}`;

      return queue.enqueue(async () => {
        const now = Date.now();
        const cached = cache?.get(cacheKey);
        if (cached && isFresh(cached, now)) {
          return cached.data;
        }

        const url = new URL(
          joinPath(
            options.baseUrl,
            basePath,
            `/previews/${encodeURIComponent(previewId)}/revisions/${publishedRevision}/artifacts/${encodeURIComponent(artifactId)}`,
          ),
        );
        const headers: Record<string, string> = {
          accept: 'application/octet-stream',
          'x-preview-protocol': HTTP_PROTOCOL_VERSION,
        };
        if (options.headers) {
          Object.assign(headers, await options.headers());
        }
        const ifNoneMatch = etag ?? cached?.etag;
        if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;

        let response: Response;
        try {
          const requestInit: RequestInit = {
            method: 'GET',
            headers,
            ...(signal ? { signal } : {}),
          };
          response = await httpFetch(url.toString(), requestInit);
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') {
            throw normalizePreviewError(err);
          }
          throw new PreviewError({
            code: ERROR_CODES.NETWORK_ERROR,
            message: (err as Error)?.message ?? '网络错误',
            retryable: true,
          });
        }

        if (response.status === 304) {
          if (!cached) {
            throw new PreviewError({
              code: ERROR_CODES.PROTOCOL_ERROR,
              message: '服务端返回 304 但客户端没有可复用的 artifact 缓存',
              retryable: false,
            });
          }
          // 命中协商缓存：刷新 storedAt 并（若存在）更新 max-age。
          const cc304 = response.headers.get('cache-control');
          const maxAge304 = parseMaxAgeMs(cc304 ?? undefined);
          const refreshed: ArtifactCacheEntry = {
            ...cached,
            storedAt: now,
            ...(cc304 ? { cacheControl: cc304 } : {}),
            ...(maxAge304 !== undefined ? { maxAgeMs: maxAge304 } : {}),
          };
          cache?.set(cacheKey, refreshed);
          return cached.data;
        }

        if (!response.ok) {
          const requestId = response.headers.get('x-request-id') ?? undefined;
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            payload = { message: response.statusText };
          }
          throw normalizePreviewError(payload, requestId ? { requestId } : {});
        }

        const buf = await response.arrayBuffer();
        if (cache) {
          const respEtag = response.headers.get('etag');
          const cc = response.headers.get('cache-control');
          const ct = response.headers.get('content-type');
          const maxAge = parseMaxAgeMs(cc ?? undefined);
          const entry: ArtifactCacheEntry = {
            data: buf,
            storedAt: now,
            ...(respEtag ? { etag: respEtag } : {}),
            ...(cc ? { cacheControl: cc } : {}),
            ...(maxAge !== undefined ? { maxAgeMs: maxAge } : {}),
            ...(ct ? { contentType: ct } : {}),
          };
          cache.set(cacheKey, entry);
        }
        return buf;
      }, signal);
    },

    fetchSheetWindow({ previewId, range, signal }) {
      return request(
        'POST',
        `/previews/${encodeURIComponent(previewId)}/revisions/${range.publishedRevision}/sheet-windows`,
        {
          body: {
            sheetId: range.sheetId,
            rowStart: range.rowStart,
            rowEnd: range.rowEnd,
            colStart: range.colStart,
            colEnd: range.colEnd,
          },
          ...(signal ? { signal } : {}),
          decode: decodeSheetWindow,
        },
      );
    },
  };
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => {
      if (i === 0) return p.replace(/\/+$/, '');
      return p.replace(/^\/+|\/+$/g, '');
    })
    .filter(Boolean)
    .join('/');
}
