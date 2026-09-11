import { DEFAULT_HTTP_BASE_PATH } from './contracts.js';
import type { PreviewState } from './contracts.js';
import { decodePreviewState } from './decode.js';
import { deepSnakeToCamel } from './case-mapping.js';

export interface PreviewEventEnvelope {
  readonly eventId: number;
  readonly previewId: string;
  readonly type: 'preview-state' | 'heartbeat';
  readonly state: PreviewState | null;
  readonly emittedAt: string;
}

export interface SubscribePreviewEventsOptions {
  readonly baseUrl: string;
  readonly previewId: string;
  readonly basePath?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: () =>
    | Record<string, string>
    | Promise<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: PreviewEventEnvelope) => void;
  readonly onError?: (error: unknown) => void;
  readonly onOpen?: () => void;
  /** 断开后自动重连；默认开启。 */
  readonly autoReconnect?: boolean;
  /** 重连基础退避（ms），默认 1000。 */
  readonly reconnectBaseMs?: number;
  /** 重连最大退避（ms），默认 30000。 */
  readonly reconnectMaxMs?: number;
}

export interface PreviewEventSubscription {
  close(): void;
}

/**
 * 订阅指定 preview 的服务器事件流（SSE）：
 *  - 使用 fetch + ReadableStream 手工解析 text/event-stream，避免 EventSource 无法自定义 Header 的限制；
 *  - 维护 Last-Event-ID，用于断线续传；
 *  - 网络错误时按指数退避自动重连（可关闭）。
 */
export function subscribePreviewEvents(
  options: SubscribePreviewEventsOptions,
): PreviewEventSubscription {
  const basePath = options.basePath ?? DEFAULT_HTTP_BASE_PATH;
  const httpFetch = options.fetch ?? globalThis.fetch;
  if (typeof httpFetch !== 'function') {
    throw new Error('subscribePreviewEvents 需要 fetch 环境');
  }

  let lastEventId = 0;
  let closed = false;
  let reconnectAttempt = 0;
  const externalSignal = options.signal;
  const controllers = new Set<AbortController>();

  const reconnectBase = options.reconnectBaseMs ?? 1000;
  const reconnectMax = options.reconnectMaxMs ?? 30_000;
  const autoReconnect = options.autoReconnect !== false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const c of controllers) {
      try {
        c.abort();
      } catch {
        /* noop */
      }
    }
    controllers.clear();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      closed = true;
    } else {
      externalSignal.addEventListener('abort', close, { once: true });
    }
  }

  const scheduleReconnect = (): void => {
    if (closed || !autoReconnect) return;
    reconnectAttempt += 1;
    const delay = Math.min(
      reconnectMax,
      reconnectBase * 2 ** (reconnectAttempt - 1),
    );
    const jitter = Math.floor(Math.random() * Math.min(500, delay / 4));
    setTimeout(() => {
      if (!closed) void connect();
    }, delay + jitter);
  };

  const parseChunk = (
    buffer: string,
    onDispatch: (fields: Map<string, string>) => void,
  ): string => {
    // 以 \n\n 或 \r\n\r\n 分事件
    const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = normalized.split('\n\n');
    const remainder = parts.pop() ?? '';
    for (const raw of parts) {
      if (!raw) continue;
      const fields = new Map<string, string>();
      for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const idx = line.indexOf(':');
        const name = idx === -1 ? line : line.slice(0, idx);
        let value = idx === -1 ? '' : line.slice(idx + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        const prev = fields.get(name);
        fields.set(name, prev ? `${prev}\n${value}` : value);
      }
      onDispatch(fields);
    }
    return remainder;
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        'cache-control': 'no-cache',
      };
      if (options.headers) Object.assign(headers, await options.headers());
      if (lastEventId > 0) {
        headers['last-event-id'] = String(lastEventId);
      }
      const url =
        joinPath(
          options.baseUrl,
          basePath,
          `/previews/${encodeURIComponent(options.previewId)}/events`,
        );
      const response = await httpFetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`SSE 建立失败：${response.status}`);
      }
      if (!response.body) {
        throw new Error('SSE 响应缺少 body');
      }
      reconnectAttempt = 0;
      options.onOpen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseChunk(buffer, (fields) => {
          const idField = fields.get('id');
          if (idField) {
            const parsed = Number.parseInt(idField, 10);
            if (Number.isFinite(parsed)) lastEventId = parsed;
          }
          const type = fields.get('event') ?? 'message';
          const data = fields.get('data');
          if (!data) return;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const camel = deepSnakeToCamel<{
              eventId?: number;
              previewId?: string;
              type?: string;
              state?: unknown;
              emittedAt?: string;
            }>(parsed);
            const envelope: PreviewEventEnvelope = {
              eventId: Number(camel.eventId ?? lastEventId),
              previewId: String(camel.previewId ?? options.previewId),
              type:
                type === 'heartbeat' || type === 'preview-state'
                  ? type
                  : 'preview-state',
              state: camel.state ? decodePreviewState(camel.state) : null,
              emittedAt: String(camel.emittedAt ?? new Date().toISOString()),
            };
            options.onEvent(envelope);
          } catch (err) {
            options.onError?.(err);
          }
        });
      }
      // 服务端主动结束流：尝试重连
      controllers.delete(controller);
      if (!closed) scheduleReconnect();
    } catch (err) {
      controllers.delete(controller);
      if (closed) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      options.onError?.(err);
      scheduleReconnect();
    }
  };

  void connect();

  return { close };
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

export interface SubscribePreviewEventsLongPollOptions {
  readonly baseUrl: string;
  readonly previewId: string;
  readonly basePath?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: () =>
    | Record<string, string>
    | Promise<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: PreviewEventEnvelope) => void;
  readonly onError?: (error: unknown) => void;
  readonly onOpen?: () => void;
  /** 处于 ready/error 稳态时的轮询间隔（ms），默认 15000。 */
  readonly idleIntervalMs?: number;
  /**
   * 处于 queued/converting 等瞬态时的轮询间隔（ms）。默认 1500。
   * 若 PreviewState.retryAfterMs 存在，则优先使用之。
   */
  readonly activeIntervalMs?: number;
  /** URL query 中额外的 profile_id（可选）。 */
  readonly profileId?: string;
  /** file_ref（可选，用于 /state 兜底端点）。 */
  readonly fileRef?: { readonly resourceKey: string; readonly version: string };
}

/**
 * SSE 兜底方案：反复 GET `/previews/{id}/state`，把状态变化包装成 `preview-state` 事件下发。
 * 使用场景：浏览器策略或代理禁止 SSE、Serverless 环境不支持长连接等。
 *
 * 特点：
 *  - 只有 state.revision / executionState / availability 发生变化时才 dispatch；
 *  - 稳态（ready/succeeded/failed/cancelled）时以 idleIntervalMs 慢速轮询；
 *  - 瞬态时以 activeIntervalMs 或 state.retryAfterMs 快速轮询；
 *  - 断网重试遵循 activeIntervalMs 上限，不会指数爆炸。
 */
export function subscribePreviewEventsLongPoll(
  options: SubscribePreviewEventsLongPollOptions,
): PreviewEventSubscription {
  const basePath = options.basePath ?? DEFAULT_HTTP_BASE_PATH;
  const httpFetch = options.fetch ?? globalThis.fetch;
  if (typeof httpFetch !== 'function') {
    throw new Error('subscribePreviewEventsLongPoll 需要 fetch 环境');
  }

  const idleIntervalMs = options.idleIntervalMs ?? 15_000;
  const activeIntervalMs = options.activeIntervalMs ?? 1_500;

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let eventCounter = 0;
  let lastRevision = -1;
  let lastExecutionState: string | null = null;
  let lastAvailability: string | null = null;
  let opened = false;
  const controllers = new Set<AbortController>();
  const externalSignal = options.signal;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const c of controllers) {
      try {
        c.abort();
      } catch {
        /* noop */
      }
    }
    controllers.clear();
  };
  if (externalSignal) {
    if (externalSignal.aborted) closed = true;
    else externalSignal.addEventListener('abort', close, { once: true });
  }

  const buildStateUrl = (): string => {
    const u = new URL(joinPath(options.baseUrl, basePath, '/state'));
    if (options.fileRef) {
      u.searchParams.set('resource_key', options.fileRef.resourceKey);
      u.searchParams.set('version', options.fileRef.version);
    } else {
      u.searchParams.set('preview_id', options.previewId);
    }
    if (options.profileId) u.searchParams.set('profile_id', options.profileId);
    return u.toString();
  };

  const scheduleNext = (delayMs: number): void => {
    if (closed) return;
    timer = setTimeout(() => {
      void tick();
    }, Math.max(0, delayMs));
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    const controller = new AbortController();
    controllers.add(controller);
    let nextDelay = idleIntervalMs;
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
      };
      if (options.headers) Object.assign(headers, await options.headers());
      const response = await httpFetch(buildStateUrl(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`long-poll 状态请求失败：${response.status}`);
      }
      const raw = (await response.json()) as unknown;
      const state = decodePreviewState(raw);
      if (!opened) {
        opened = true;
        options.onOpen?.();
      }
      const changed =
        state.revision !== lastRevision ||
        state.executionState !== lastExecutionState ||
        state.availability !== lastAvailability;
      lastRevision = state.revision;
      lastExecutionState = state.executionState;
      lastAvailability = state.availability;
      if (changed) {
        eventCounter += 1;
        options.onEvent({
          eventId: eventCounter,
          previewId: state.previewId,
          type: 'preview-state',
          state,
          emittedAt: new Date().toISOString(),
        });
      }
      const isStable =
        state.executionState === 'succeeded' ||
        state.executionState === 'failed' ||
        state.executionState === 'cancelled';
      nextDelay =
        state.retryAfterMs ?? (isStable ? idleIntervalMs : activeIntervalMs);
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        options.onError?.(err);
      }
      nextDelay = activeIntervalMs;
    } finally {
      controllers.delete(controller);
    }
    scheduleNext(nextDelay);
  };

  scheduleNext(0);
  return { close };
}
