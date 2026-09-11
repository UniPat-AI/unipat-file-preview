import type {
  Authorize,
  FileRef,
  PreviewErrorPayload,
  PreviewState,
} from '@unipat/file-preview-contracts';
import { HostErrors, HostPreviewError, isHostPreviewError } from './errors.js';
import type {
  ArtifactStorage,
  IdempotencyStore,
  PreviewRecordRow,
  ResultRow,
  SourceProvider,
  SourceRow,
  Store,
} from './ports.js';
import type { Logger, RequestContext } from './types.js';
import { Orchestrator } from './orchestrator.js';

export interface PreviewHostOptions {
  readonly namespace: string;
  readonly authorize: Authorize;
  readonly sourceProvider: SourceProvider;
  readonly artifactStorage: ArtifactStorage;
  readonly store: Store;
  readonly idempotencyStore: IdempotencyStore;
  readonly orchestrator: Orchestrator;
  readonly logger: Logger;
  readonly idempotencyTtlMs?: number;
}

export interface EnsureRequestInput {
  readonly file: FileRef;
  readonly profileId: string;
  readonly idempotencyKey?: string;
}

export interface PreviewHost {
  ensurePreview(
    ctx: RequestContext,
    input: EnsureRequestInput,
  ): Promise<PreviewState>;
  getPreviewState(
    ctx: RequestContext,
    input: { file: FileRef; profileId: string },
  ): Promise<PreviewState>;
  cancel(
    ctx: RequestContext,
    input: { previewId: string },
  ): Promise<PreviewState>;
  retry(
    ctx: RequestContext,
    input: { previewId: string; idempotencyKey?: string },
  ): Promise<PreviewState>;
  clear(ctx: RequestContext, input: { previewId: string }): Promise<void>;
  /** 根据 previewId 直接读取当前 PreviewState（SSE / 事件桥接用）。 */
  getPreviewStateById(
    ctx: RequestContext,
    input: { previewId: string },
  ): Promise<PreviewState>;
  getManifest(
    ctx: RequestContext,
    input: { previewId: string; publishedRevision: number },
  ): Promise<Readonly<Record<string, unknown>>>;
  getArtifact(
    ctx: RequestContext,
    input: {
      previewId: string;
      publishedRevision: number;
      artifactId: string;
      range?: { start: number; endInclusive: number };
    },
  ): Promise<{
    stream: ReadableStream<Uint8Array>;
    sizeBytes: number;
    mediaType: string;
    sha256: string;
    totalSize: number;
    range?: { start: number; endInclusive: number };
  }>;
}

export function createPreviewHost(options: PreviewHostOptions): PreviewHost {
  const idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;

  async function loadPreviewOrFail(
    previewId: string,
    ctx?: RequestContext,
  ): Promise<PreviewRecordRow> {
    const preview = await options.store.getPreview(previewId);
    if (!preview) throw HostErrors.resourceNotFound();
    if (ctx) {
      if (
        preview.namespace !== ctx.namespace ||
        preview.tenantId !== ctx.principal.tenantId
      ) {
        throw HostErrors.resourceNotFound();
      }
    }
    return preview;
  }

  async function loadSourceOrFail(sourceId: string): Promise<SourceRow> {
    const source = await options.store.getSource(sourceId);
    if (!source) throw HostErrors.sourceUnavailable();
    return source;
  }

  async function checkSourceAvailable(
    source: SourceRow,
    signal: AbortSignal,
  ): Promise<void> {
    if (source.status !== 'active') {
      throw HostErrors.sourceUnavailable();
    }
    if (options.sourceProvider.isAvailable) {
      const ok = await options.sourceProvider.isAvailable(
        {
          resourceKey: source.resourceKey,
          version: source.sourceVersion,
          filename: source.filename,
          extension: source.extension,
          sizeBytes: source.sizeBytes,
          ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
          handle: {},
        },
        signal,
      );
      if (!ok) {
        throw HostErrors.sourceUnavailable();
      }
    }
  }

  async function ensureAuthorized(
    ctx: RequestContext,
    file: FileRef,
    action: 'view' | 'generate' | 'retry' | 'cancel' | 'clear',
  ): Promise<void> {
    const decision = await options.authorize({
      principal: ctx.principal,
      file,
      action,
      signal: ctx.signal,
    });
    if (!decision.allowed) throw HostErrors.actionForbidden();
  }

  async function toState(
    ctx: RequestContext,
    preview: PreviewRecordRow,
    source: SourceRow,
    published: ResultRow | null,
  ): Promise<PreviewState> {
    const decision = await options.authorize({
      principal: ctx.principal,
      file: {
        resourceKey: source.resourceKey,
        version: source.sourceVersion,
      },
      action: 'view',
      signal: ctx.signal,
    });
    const permissions = decision.permissions ?? {
      downloadOriginal: false,
      print: false,
      copy: false,
      retry: false,
    };
    const availability: PreviewState['availability'] = published
      ? published.availability
      : 'none';
    const isPrevious =
      published !== null &&
      preview.executionState !== 'succeeded' &&
      preview.publishedRevision !== null;

    const warnings: PreviewState['warnings'] = published
      ? ((published.manifest as { warnings?: PreviewState['warnings'] })
          ?.warnings ?? [])
      : [];

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
      permissions,
      warnings,
      error: preview.lastError,
      retryAfterMs:
        preview.executionState === 'queued' ||
        preview.executionState === 'running'
          ? 1000
          : null,
    };
  }

  return {
    async ensurePreview(ctx, input) {
      await ensureAuthorized(ctx, input.file, 'view');
      await ensureAuthorized(ctx, input.file, 'generate');

      let operationId: string | undefined;
      if (input.idempotencyKey) {
        const hash = simpleHash(
          JSON.stringify({
            file: input.file,
            profileId: input.profileId,
            namespace: ctx.namespace,
            tenantId: ctx.principal.tenantId,
          }),
        );
        const reservation = await options.idempotencyStore.reserve({
          scope: `ensure:${ctx.namespace}`,
          key: input.idempotencyKey,
          requestHash: hash,
          ttlMs: idempotencyTtlMs,
        });
        if (reservation.status === 'conflict') {
          throw HostErrors.idempotencyConflict();
        }
        if (reservation.status === 'in_progress') {
          throw HostErrors.requestInProgress();
        }
        if (reservation.status === 'reserved') {
          operationId = reservation.operationId;
        }
      }

      const resolved = await options.sourceProvider.resolve(
        { namespace: ctx.namespace, tenantId: ctx.principal.tenantId },
        input.file,
        ctx.signal,
      );

      const ensured = await options.store.ensurePreview({
        namespace: ctx.namespace,
        tenantId: ctx.principal.tenantId,
        file: input.file,
        profileId: input.profileId,
        source: resolved,
        actorUserId: ctx.principal.userId,
      });

      if (operationId && input.idempotencyKey) {
        await options.idempotencyStore.complete({
          scope: `ensure:${ctx.namespace}`,
          key: input.idempotencyKey,
          operationId,
        });
      }

      const published = ensured.preview.publishedRevision
        ? await options.store.getResult(
            ensured.preview.id,
            ensured.preview.publishedRevision,
          )
        : null;

      return toState(ctx, ensured.preview, ensured.source, published);
    },

    async getPreviewState(ctx, input) {
      await ensureAuthorized(ctx, input.file, 'view');
      const found = await options.store.findPreview({
        namespace: ctx.namespace,
        tenantId: ctx.principal.tenantId,
        file: input.file,
        profileId: input.profileId,
      });
      if (!found) {
        throw HostErrors.resourceNotFound('预览尚未生成');
      }
      await checkSourceAvailable(found.source, ctx.signal);
      const published = found.preview.publishedRevision
        ? await options.store.getResult(
            found.preview.id,
            found.preview.publishedRevision,
          )
        : null;
      return toState(ctx, found.preview, found.source, published);
    },

    async cancel(ctx, input) {
      const preview = await loadPreviewOrFail(input.previewId, ctx);
      const source = await loadSourceOrFail(preview.sourceId);
      await checkSourceAvailable(source, ctx.signal);
      await ensureAuthorized(
        ctx,
        {
          resourceKey: source.resourceKey,
          version: source.sourceVersion,
        },
        'cancel',
      );
      await options.store.cancelGeneration({
        previewId: input.previewId,
        actorUserId: ctx.principal.userId,
      });
      options.orchestrator.abortPreviewJobs(input.previewId);
      const refreshed = await loadPreviewOrFail(input.previewId, ctx);
      const published = refreshed.publishedRevision
        ? await options.store.getResult(
            refreshed.id,
            refreshed.publishedRevision,
          )
        : null;
      return toState(ctx, refreshed, source, published);
    },

    async clear(ctx, input) {
      const preview = await loadPreviewOrFail(input.previewId, ctx);
      const source = await loadSourceOrFail(preview.sourceId);
      await ensureAuthorized(
        ctx,
        {
          resourceKey: source.resourceKey,
          version: source.sourceVersion,
        },
        'clear',
      );
      options.orchestrator.abortPreviewJobs(input.previewId);
      await options.store.clearResults({
        previewId: input.previewId,
        actorUserId: ctx.principal.userId,
      });
    },

    async retry(ctx, input) {
      const preview = await loadPreviewOrFail(input.previewId, ctx);
      const source = await loadSourceOrFail(preview.sourceId);
      await checkSourceAvailable(source, ctx.signal);
      await ensureAuthorized(
        ctx,
        {
          resourceKey: source.resourceKey,
          version: source.sourceVersion,
        },
        'retry',
      );
      await options.store.enqueueRetry({
        previewId: input.previewId,
        actorUserId: ctx.principal.userId,
      });
      const refreshed = await loadPreviewOrFail(input.previewId, ctx);
      const published = refreshed.publishedRevision
        ? await options.store.getResult(
            refreshed.id,
            refreshed.publishedRevision,
          )
        : null;
      return toState(ctx, refreshed, source, published);
    },

    async getPreviewStateById(ctx, input) {
      const preview = await loadPreviewOrFail(input.previewId, ctx);
      const source = await loadSourceOrFail(preview.sourceId);
      await checkSourceAvailable(source, ctx.signal);
      await ensureAuthorized(
        ctx,
        {
          resourceKey: source.resourceKey,
          version: source.sourceVersion,
        },
        'view',
      );
      const published = preview.publishedRevision
        ? await options.store.getResult(preview.id, preview.publishedRevision)
        : null;
      return toState(ctx, preview, source, published);
    },

    async getManifest(ctx, input) {
      const preview = await loadPreviewOrFail(input.previewId, ctx);
      const source = await loadSourceOrFail(preview.sourceId);
      await checkSourceAvailable(source, ctx.signal);
      await ensureAuthorized(
        ctx,
        {
          resourceKey: source.resourceKey,
          version: source.sourceVersion,
        },
        'view',
      );
      const result = await options.store.getResult(
        input.previewId,
        input.publishedRevision,
      );
      if (!result) throw HostErrors.resourceNotFound();
      return sanitizeManifestForClient(result.manifest);
    },

    async getArtifact(ctx, input) {
      const preview = await loadPreviewOrFail(input.previewId, ctx);
      const source = await loadSourceOrFail(preview.sourceId);
      await checkSourceAvailable(source, ctx.signal);
      await ensureAuthorized(
        ctx,
        {
          resourceKey: source.resourceKey,
          version: source.sourceVersion,
        },
        'view',
      );
      const result = await options.store.getResult(
        input.previewId,
        input.publishedRevision,
      );
      if (!result) throw HostErrors.resourceNotFound();
      const manifest = result.manifest as {
        artifacts?: Array<Record<string, unknown>>;
      };
      const entry = (manifest.artifacts ?? []).find(
        (a) => a['artifact_id'] === input.artifactId,
      );
      if (!entry) throw HostErrors.resourceNotFound();
      const objectKey = String(entry['object_key'] ?? '');
      if (!objectKey) {
        throw HostErrors.protocolError('artifact 缺少 object_key');
      }
      const stat = await options.artifactStorage.stat(objectKey, ctx.signal);
      if (!stat) throw HostErrors.resourceNotFound();

      let range: { start: number; endInclusive: number } | undefined;
      let start = 0;
      let endInclusive = stat.sizeBytes - 1;

      if (input.range) {
        if (
          input.range.start < 0 ||
          input.range.start >= stat.sizeBytes ||
          input.range.start > input.range.endInclusive
        ) {
          throw HostErrors.rangeNotSatisfiable();
        }
        start = input.range.start;
        endInclusive = Math.min(input.range.endInclusive, stat.sizeBytes - 1);
        range = { start, endInclusive };
      }

      const stream = await options.artifactStorage.openRange(
        objectKey,
        start,
        endInclusive,
        ctx.signal,
      );
      return {
        stream,
        sizeBytes: endInclusive - start + 1,
        mediaType: stat.mediaType,
        sha256: stat.sha256,
        totalSize: stat.sizeBytes,
        ...(range ? { range } : {}),
      };
    },
  };
}

function mapStage(state: PreviewRecordRow['executionState']) {
  // 简化映射：真实实现应基于 job.stage
  switch (state) {
    case 'queued':
      return 'queued' as const;
    case 'running':
      return 'converting' as const;
    default:
      return 'queued' as const;
  }
}

function sanitizeManifestForClient(
  manifest: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rawArtifacts = manifest['artifacts'] as
    | Array<Record<string, unknown>>
    | undefined;
  if (!rawArtifacts) return manifest;
  const cleaned = rawArtifacts.map((a) => {
    const { object_key: _ok, ...rest } = a as {
      object_key?: unknown;
      [k: string]: unknown;
    };
    return rest;
  });
  return { ...manifest, artifacts: cleaned };
}

function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

// 保留以便未来暴露；避免打包器 tree-shake 时误删。
export type { PreviewErrorPayload };
export { HostPreviewError, isHostPreviewError };
