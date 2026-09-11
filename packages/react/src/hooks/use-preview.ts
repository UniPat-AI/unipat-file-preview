import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CLIENT_POLL_MAX_INTERVAL_MS,
  CLIENT_POLL_MIN_INTERVAL_MS,
  type FileRef,
  type Manifest,
  type PreviewState,
} from '../contracts/index.js';
import {
  normalizePreviewError,
  PreviewError,
  subscribePreviewEvents,
  type FetchArtifactInput,
  type FetchManifestInput,
  type GetStateInput,
  type PreviewClient,
  type PreviewEventSubscription,
} from '../contracts/index.js';

export interface UsePreviewInput {
  readonly client: PreviewClient;
  readonly file: FileRef;
  readonly profileId?: string;
  readonly idempotencyKey?: string;
  /**
   * 身份识别标识（如当前租户 ID 或用户 ID）。
   * 切换身份时，组件将立即终止旧请求并清空当前预览状态，防止跨身份串扰。
   */
  readonly identityKey?: string;
  readonly autoGenerate?: boolean;
  readonly pollIntervalMs?: number;
  /**
   * 可选的 SSE 事件订阅配置。若提供且支持，将优先通过 SSE 接收状态变更；
   * 长轮询作为退避兜底。
   */
  readonly events?: {
    readonly baseUrl: string;
    readonly basePath?: string;
    readonly headers?: () =>
      | Record<string, string>
      | Promise<Record<string, string>>;
  };
  }

  export type PreviewPhase =
  | 'idle'
  | 'loading'
  | 'polling'
  | 'ready'
  | 'partial'
  | 'error';

  export interface UsePreviewResult {
  readonly phase: PreviewPhase;
  readonly state: PreviewState | null;
  readonly error: PreviewError | null;
  readonly refresh: () => Promise<void>;
  readonly requestGenerate: (idempotencyKey?: string) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly clear: () => Promise<void>;
  }

const TERMINAL_EXECUTION_STATES = new Set<PreviewState['executionState']>([
  'succeeded',
  'failed',
  'cancelled',
]);

export function usePreview(input: UsePreviewInput): UsePreviewResult {
  const {
    client,
    file,
    profileId,
    idempotencyKey,
    autoGenerate = true,
    pollIntervalMs,
    events,
  } = input;

  const [state, setState] = useState<PreviewState | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>('idle');

  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const stateRef = useRef<PreviewState | null>(null);
  const sseRef = useRef<PreviewEventSubscription | null>(null);
  const sseActiveRef = useRef(false);

  const key = useMemo(
    () =>
      `${input.identityKey ?? ''}::${file.resourceKey}::${file.version}::${profileId ?? ''}`,
    [input.identityKey, file.resourceKey, file.version, profileId, client],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      sseRef.current?.close();
      sseRef.current = null;
      sseActiveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setState(null);
    setError(null);
    setPhase('loading');
    stateRef.current = null;

    abortRef.current?.abort();
    sseRef.current?.close();
    sseRef.current = null;
    sseActiveRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;

    void bootstrap(ac.signal);

    return () => {
      ac.abort();
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      sseRef.current?.close();
      sseRef.current = null;
      sseActiveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function bootstrap(signal: AbortSignal) {
    try {
      const initial = await client.getState({
        file,
        ...(profileId !== undefined ? { profileId } : {}),
        signal,
      });
      applyState(initial);
      if (autoGenerate && initial.availability === 'none') {
        await doGenerate(idempotencyKey, signal);
      } else if (needsPoll(initial)) {
        schedulePoll();
      }
    } catch (err) {
      if (signal.aborted) return;
      const previewErr = normalizePreviewError(err);
      if (autoGenerate && previewErr.code === 'RESOURCE_NOT_FOUND') {
        await doGenerate(idempotencyKey, signal);
      } else {
        applyError(err);
      }
    }
  }

  async function doGenerate(idem: string | undefined, signal: AbortSignal) {
    const nextIdem = idem ?? cryptoRandomKey();
    try {
      const next = await client.requestGenerate({
        file,
        ...(profileId !== undefined ? { profileId } : {}),
        idempotencyKey: nextIdem,
        signal,
      });
      applyState(next);
      if (needsPoll(next)) schedulePoll();
    } catch (err) {
      if (signal.aborted) return;
      applyError(err);
    }
  }

  function applyState(s: PreviewState) {
    if (!mountedRef.current) return;
    stateRef.current = s;
    setState(s);
    setError(null);
    if (s.availability === 'ready') setPhase('ready');
    else if (s.availability === 'partial') setPhase('partial');
    else if (
      s.executionState === 'failed' ||
      s.executionState === 'cancelled'
    ) {
      setPhase('error');
      if (s.error) setError(new PreviewError(s.error));
    } else if (needsPoll(s)) setPhase('polling');
    else setPhase('loading');
    // 一旦拿到 previewId，就尝试建立 SSE（幂等；仅建立一次）
    ensureSseIfNeeded(s);
  }

  function ensureSseIfNeeded(s: PreviewState) {
    if (!events) return;
    if (sseRef.current) return;
    if (!s.previewId) return;
    const previewId = s.previewId;
    try {
      const sub = subscribePreviewEvents({
        baseUrl: events.baseUrl,
        previewId,
        ...(events.basePath !== undefined ? { basePath: events.basePath } : {}),
        ...(events.headers ? { headers: events.headers } : {}),
        onOpen: () => {
          sseActiveRef.current = true;
          // SSE 活跃后暂停轮询
          if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        },
        onEvent: (evt) => {
          if (evt.type === 'preview-state' && evt.state) {
            applyState(evt.state);
          }
        },
        onError: () => {
          // 保持 SSE 内部自动重连；此处仅在断线时回退到轮询
          sseActiveRef.current = false;
          const current = stateRef.current;
          if (current && needsPoll(current)) schedulePoll();
        },
      });
      sseRef.current = sub;
    } catch {
      // 环境不支持 fetch stream 等场景：静默回退到轮询
    }
  }

  function applyError(err: unknown) {
    if (!mountedRef.current) return;
    const normalized = normalizePreviewError(err);
    setError(normalized);
    setPhase('error');
  }

  function schedulePoll() {
    if (sseActiveRef.current) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    const interval = clampPollInterval(pollIntervalMs);
    pollTimerRef.current = setTimeout(() => {
      const ac = abortRef.current;
      if (!ac || ac.signal.aborted) return;
      void poll(ac.signal);
    }, interval);
  }

  async function poll(signal: AbortSignal) {
    try {
      const next = await client.getState({
        file,
        ...(profileId !== undefined ? { profileId } : {}),
        signal,
      });
      applyState(next);
      if (needsPoll(next)) schedulePoll();
    } catch (err) {
      if (signal.aborted) return;
      applyError(err);
    }
  }

  return {
    phase,
    state,
    error,
    refresh: async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      await bootstrap(ac.signal);
    },
    requestGenerate: async (nextIdem) => {
      const ac = abortRef.current ?? new AbortController();
      abortRef.current = ac;
      await doGenerate(nextIdem ?? idempotencyKey, ac.signal);
    },
    cancel: async () => {
      const current = stateRef.current;
      if (!current) return;
      try {
        const next = await client.cancel({ previewId: current.previewId });
        applyState(next);
      } catch (err) {
        applyError(err);
      }
    },
    retry: async () => {
      const current = stateRef.current;
      if (!current) {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        await bootstrap(ac.signal);
        return;
      }
      try {
        const next = await client.retry({ previewId: current.previewId });
        applyState(next);
        if (needsPoll(next)) schedulePoll();
      } catch (err) {
        applyError(err);
      }
    },
    clear: async () => {
      const current = stateRef.current;
      if (!current) return;
      try {
        await client.clear({ previewId: current.previewId });
        if (mountedRef.current) {
          stateRef.current = null;
          setState(null);
          setError(null);
          setPhase('idle');
        }
      } catch (err) {
        applyError(err);
      }
    },
  };
}

export function useManifest(
  client: PreviewClient,
  state: PreviewState | null,
): {
  manifest: Manifest | null;
  error: PreviewError | null;
  loading: boolean;
} {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [loading, setLoading] = useState(false);

  const target = useMemo(() => {
    if (!state || state.availability === 'none') return null;
    if (state.publishedRevision === null) return null;
    return {
      previewId: state.previewId,
      publishedRevision: state.publishedRevision,
    };
  }, [state]);

  useEffect(() => {
    if (!target) {
      setManifest(null);
      setError(null);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    const input: FetchManifestInput = { ...target, signal: ac.signal };
    client
      .fetchManifest(input)
      .then((m) => {
        if (ac.signal.aborted) return;
        setManifest(m);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(normalizePreviewError(err));
        setLoading(false);
      });
    return () => ac.abort();
  }, [client, target?.previewId, target?.publishedRevision]);

  return { manifest, error, loading };
}

export interface UseArtifactResult {
  bytes: ArrayBuffer | null;
  error: PreviewError | null;
  loading: boolean;
}

export function useArtifact(
  client: PreviewClient,
  input: {
    previewId: string;
    publishedRevision: number;
    artifactId: string;
  } | null,
): UseArtifactResult {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!input) {
      setBytes(null);
      setError(null);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    const req: FetchArtifactInput = { ...input, signal: ac.signal };
    client
      .fetchArtifact(req)
      .then((buf) => {
        if (ac.signal.aborted) return;
        setBytes(buf);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(normalizePreviewError(err));
        setLoading(false);
      });
    return () => ac.abort();
  }, [client, input?.previewId, input?.publishedRevision, input?.artifactId]);

  return { bytes, error, loading };
}

function needsPoll(s: PreviewState): boolean {
  if (s.availability === 'ready') return false;
  if (TERMINAL_EXECUTION_STATES.has(s.executionState)) return false;
  return true;
}

function clampPollInterval(ms: number | undefined): number {
  const raw = ms ?? CLIENT_POLL_MIN_INTERVAL_MS;
  if (raw < CLIENT_POLL_MIN_INTERVAL_MS) return CLIENT_POLL_MIN_INTERVAL_MS;
  if (raw > CLIENT_POLL_MAX_INTERVAL_MS) return CLIENT_POLL_MAX_INTERVAL_MS;
  return raw;
}

function cryptoRandomKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `idem_${g.crypto.randomUUID()}`;
  return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// 让 TS 不因为 GetStateInput 未使用而报错（保留导出语义）
export type { GetStateInput };
