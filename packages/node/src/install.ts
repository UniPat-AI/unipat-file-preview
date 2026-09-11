import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Authorize, PreviewState } from '@unipat/file-preview-contracts';
import { createPreviewHost, type PreviewHost } from './host.js';
import { createHttpHandler } from './http.js';
import { Orchestrator, type OrchestratorOptions } from './orchestrator.js';
import { PreviewEventBus } from './event-bus.js';
import type {
  ArtifactStorage,
  IdempotencyStore,
  PreviewRecordRow,
  Runner,
  SourceProvider,
  SourceRow,
  Store,
} from './ports.js';
import type { Logger, Principal } from './types.js';

export interface InstallFilePreviewOptions {
  readonly namespace: string;
  readonly authorize: Authorize;
  readonly sourceProvider: SourceProvider;
  readonly artifactStorage: ArtifactStorage;
  readonly store: Store;
  readonly idempotencyStore: IdempotencyStore;
  readonly runner: Runner;
  readonly logger: Logger;
  readonly resolvePrincipal: (req: IncomingMessage) => Promise<Principal>;
  readonly basePath?: string;
  readonly workerId?: string;
  readonly orchestrator?: Partial<
    Omit<
      OrchestratorOptions,
      | 'namespace'
      | 'workerId'
      | 'store'
      | 'sourceProvider'
      | 'artifactStorage'
      | 'runner'
      | 'logger'
    >
  >;
  readonly idempotencyTtlMs?: number;
  readonly autoStart?: boolean;
}

export interface InstalledFilePreview {
  readonly host: PreviewHost;
  readonly orchestrator: Orchestrator;
  readonly eventBus: PreviewEventBus;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  start(): void;
  stop(): Promise<void>;
}

export function installFilePreview(
  server: Server | null | undefined,
  options: InstallFilePreviewOptions,
): InstalledFilePreview {
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const eventBus = new PreviewEventBus();

  // 内部工具：orchestrator 触发 onStateChanged 后，直接从 store 快照 state 并 publish。
  // 注意：这里不走 authorize（SSE 端点接入时已完成权限校验），仅广播状态变化。
  const publishStateAsync = (previewId: string): void => {
    void (async () => {
      try {
        const preview = await options.store.getPreview(previewId);
        if (!preview) return;
        const source = await options.store.getSource(preview.sourceId);
        if (!source) return;
        const published = preview.publishedRevision
          ? await options.store.getResult(preview.id, preview.publishedRevision)
          : null;
        const state = snapshotPreviewState(preview, source, !!published);
        eventBus.publishState(previewId, state);
      } catch (err) {
        options.logger.log('debug', 'event_bus.publish_failed', {
          previewId,
          message: (err as Error)?.message ?? String(err),
        });
      }
    })();
  };

  const orchestrator = new Orchestrator({
    namespace: options.namespace,
    workerId,
    store: options.store,
    sourceProvider: options.sourceProvider,
    artifactStorage: options.artifactStorage,
    runner: options.runner,
    logger: options.logger,
    onStateChanged: publishStateAsync,
    ...(options.orchestrator ?? {}),
  });

  const host = createPreviewHost({
    namespace: options.namespace,
    authorize: options.authorize,
    sourceProvider: options.sourceProvider,
    artifactStorage: options.artifactStorage,
    store: options.store,
    idempotencyStore: options.idempotencyStore,
    orchestrator,
    logger: options.logger,
    ...(options.idempotencyTtlMs !== undefined
      ? { idempotencyTtlMs: options.idempotencyTtlMs }
      : {}),
  });

  const handler = createHttpHandler({
    host,
    namespace: options.namespace,
    logger: options.logger,
    resolvePrincipal: options.resolvePrincipal,
    eventBus,
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
  });

  let attached = false;
  let started = false;

  const start = (): void => {
    if (server && !attached) {
      server.on('request', handler);
      attached = true;
    }
    if (!started) {
      orchestrator.start();
      started = true;
    }
  };

  const stop = async (): Promise<void> => {
    if (server && attached) {
      server.off('request', handler);
      attached = false;
    }
    if (started) {
      await orchestrator.stop();
      started = false;
    }
  };

  if (options.autoStart !== false) {
    start();
  }

  return {
    host,
    orchestrator,
    eventBus,
    handler,
    start,
    stop,
  };
}

function snapshotPreviewState(
  preview: PreviewRecordRow,
  source: SourceRow,
  hasPublished: boolean,
): PreviewState {
  const availability: PreviewState['availability'] = hasPublished
    ? 'ready'
    : 'none';
  const isPrevious =
    hasPublished &&
    preview.executionState !== 'succeeded' &&
    preview.publishedRevision !== null;
  return {
    previewId: preview.id,
    fileRef: {
      resourceKey: source.resourceKey,
      version: source.sourceVersion,
    },
    profileId: preview.profileId,
    generation: preview.generation,
    executionState: preview.executionState,
    availability,
    stage: mapStage(preview.executionState),
    progress: null,
    revision: preview.revision,
    publishedRevision: preview.publishedRevision,
    isPreviousResult: isPrevious,
    permissions: {
      downloadOriginal: false,
      print: false,
      copy: false,
      retry: false,
    },
    warnings: [],
    error: preview.lastError,
    retryAfterMs:
      preview.executionState === 'queued' ||
      preview.executionState === 'running'
        ? 1000
        : null,
  };
}

function mapStage(
  execution: PreviewRecordRow['executionState'],
): PreviewState['stage'] {
  switch (execution) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'converting';
    default:
      return 'queued';
  }
}
