import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ERROR_CODES,
  MANIFEST_SCHEMA_VERSION,
  type PreviewErrorPayload,
} from '@unipat/file-preview-contracts';
import type {
  ArtifactStorage,
  JobRow,
  Runner,
  SourceProvider,
  Store,
} from './ports.js';
import { HostErrors, HostPreviewError, isHostPreviewError } from './errors.js';
import type { Logger } from './types.js';

export interface OrchestratorOptions {
  readonly namespace: string;
  readonly workerId: string;
  readonly store: Store;
  readonly sourceProvider: SourceProvider;
  readonly artifactStorage: ArtifactStorage;
  readonly runner: Runner;
  readonly logger: Logger;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly wallClockMs?: number;
  readonly artifactPrefix?: string;
  readonly cleanupIntervalMs?: number;
  readonly ttlMs?: number;
  /** 每当 preview 状态可能变化时触发（发布/失败/取消/heartbeat）。用于 SSE 事件桥接。 */
  readonly onStateChanged?: (previewId: string) => void;
}

export class Orchestrator {
  private readonly opts: Required<Omit<OrchestratorOptions, 'onStateChanged'>>;
  private readonly onStateChanged?: (previewId: string) => void;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private stopSignal: AbortController | null = null;
  private readonly activeJobs = new Map<string, AbortController>();

  constructor(options: OrchestratorOptions) {
    const { onStateChanged, ...rest } = options;
    this.opts = {
      pollIntervalMs: 100,
      leaseDurationMs: 60_000,
      wallClockMs: 480_000,
      artifactPrefix: 'preview-results',
      cleanupIntervalMs: 60_000,
      ttlMs: 24 * 60 * 60 * 1000,
      ...rest,
    };
    if (onStateChanged) this.onStateChanged = onStateChanged;
  }

  private notifyStateChanged(previewId: string): void {
    if (!this.onStateChanged) return;
    try {
      this.onStateChanged(previewId);
    } catch {
      /* 通知失败不应影响主流程 */
    }
  }

  /** 主动中止指定 job（例如收到 cancel 请求）。返回是否命中活跃任务。 */
  abortJob(jobId: string, reason?: string): boolean {
    const ctrl = this.activeJobs.get(jobId);
    if (!ctrl) return false;
    ctrl.abort(new Error(reason ?? 'cancelled_by_host'));
    return true;
  }

  /** 中止当前 preview 关联的活跃 job（如果有）。 */
  abortPreviewJobs(previewId: string): number {
    let count = 0;
    for (const [, ctrl] of this.activeJobs) {
      const p = (ctrl as AbortController & { __previewId?: string })
        .__previewId;
      if (p === previewId) {
        ctrl.abort(new Error('cancelled_by_host'));
        count += 1;
      }
    }
    return count;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopSignal = new AbortController();
    this.loopPromise = Promise.all([
      this.loop(this.stopSignal.signal),
      this.cleanupLoop(this.stopSignal.signal),
    ]).then(() => undefined);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopSignal?.abort();
    for (const [jobId, ac] of this.activeJobs) {
      ac.abort(new Error('orchestrator_stopped'));
      try {
        await this.opts.runner.cancel(jobId);
      } catch {
        // ignore
      }
    }
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
    this.loopPromise = null;
    this.stopSignal = null;
  }

  /** 立即领取并推进一次；供测试与最小 e2e 用（无需长期后台）。 */
  async tick(): Promise<boolean> {
    const claimed = await this.opts.store.claimJob({
      workerId: this.opts.workerId,
      namespace: this.opts.namespace,
      leaseDurationMs: this.opts.leaseDurationMs,
    });
    if (!claimed) return false;
    await this.processJob(claimed);
    return true;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.tick().catch((err) => {
        this.opts.logger.log('error', 'orchestrator.tick_error', {
          message: (err as Error)?.message ?? String(err),
        });
        return false;
      });
      if (!worked) {
        await sleep(this.opts.pollIntervalMs, signal).catch(() => undefined);
      }
    }
  }

  /** 立即扫描一次过期资源；测试与最小 e2e 用。 */
  async sweepOnce(): Promise<readonly string[]> {
    if (typeof this.opts.store.sweepExpired !== 'function') return [];
    return this.opts.store.sweepExpired({
      namespace: this.opts.namespace,
      now: new Date(),
      ttlMs: this.opts.ttlMs,
    });
  }

  private async cleanupLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.opts.cleanupIntervalMs, signal).catch(() => undefined);
      if (signal.aborted) return;
      const removed = await this.sweepOnce().catch((err) => {
        this.opts.logger.log('error', 'orchestrator.cleanup_error', {
          message: (err as Error)?.message ?? String(err),
        });
        return [] as readonly string[];
      });
      if (removed.length > 0) {
        this.opts.logger.log('info', 'orchestrator.cleanup_swept', {
          count: removed.length,
        });
      }
    }
  }

  private async processJob(job: JobRow): Promise<void> {
    const jobSignal = new AbortController();
    (jobSignal as AbortController & { __previewId?: string }).__previewId =
      job.previewId;
    this.activeJobs.set(job.id, jobSignal);
    const wallTimer = setTimeout(
      () => jobSignal.abort(new Error('wall_clock_exceeded')),
      this.opts.wallClockMs,
    );

    try {
      const preview = await this.opts.store.getPreview(job.previewId);
      if (!preview) throw HostErrors.resourceNotFound();
      const source = await this.opts.store.getSource(preview.sourceId);
      if (!source) throw HostErrors.sourceUnavailable();

      let currentStage: JobRow['stage'] = 'fetching';
      let currentProgress: JobRow['progress'] = null;

      const heartbeat = async (
        stage: JobRow['stage'],
        progress: JobRow['progress'] = null,
      ): Promise<void> => {
        currentStage = stage;
        currentProgress = progress;
        const ok = await this.opts.store.heartbeat({
          jobId: job.id,
          leaseToken: job.leaseToken!,
          leaseDurationMs: this.opts.leaseDurationMs,
          stage,
          progress,
        });
        if (!ok) {
          jobSignal.abort(new Error('lease_lost'));
          throw HostErrors.serviceUnavailable('租约已失效');
        }
      };

      const heartbeatTimer = setInterval(() => {
        if (jobSignal.signal.aborted) return;
        heartbeat(currentStage, currentProgress).catch(() => undefined);
      }, Math.max(1000, Math.min(10000, Math.floor(this.opts.leaseDurationMs / 3))));

      // 1. fetching：拉取原文件到临时目录
      await heartbeat('fetching');
      const workDir = await mkdtemp(
        join(tmpdir(), `preview-${job.id.slice(0, 8)}-`),
      );
      const ext = source.extension
        ? source.extension.startsWith('.')
          ? source.extension
          : `.${source.extension}`
        : '.bin';
      const inputPath = join(workDir, `input${ext}`);
      const outputDir = join(workDir, 'out');
      await mkdir(outputDir, { recursive: true });

      try {
        const resolved = await this.opts.sourceProvider.resolve(
          { namespace: preview.namespace, tenantId: preview.tenantId },
          {
            resourceKey: source.resourceKey,
            version: source.sourceVersion,
          },
          jobSignal.signal,
        );
        const opened = await this.opts.sourceProvider.open(resolved, {
          signal: jobSignal.signal,
        });
        const inputBytes = await readWebStream(opened.stream);
        await writeFile(inputPath, inputBytes);
        const inputSha256 = createHash('sha256')
          .update(inputBytes)
          .digest('hex');
        if (source.expectedSha256 && source.expectedSha256 !== inputSha256) {
          throw HostErrors.sourceChanged();
        }

        // 2. inspecting
        await heartbeat('inspecting');

        // 3. converting
        await heartbeat('converting');
        const candidate = await this.opts.runner.run(
          {
            jobId: job.id,
            previewId: job.previewId,
            namespace: preview.namespace,
            tenantId: preview.tenantId,
            profileId: preview.profileId,
            profileConfig: {},
            source: {
              filename: source.filename,
              extension: source.extension,
              sizeBytes: source.sizeBytes,
            },
          },
          {
            path: inputPath,
            sizeBytes: inputBytes.byteLength,
            sha256: inputSha256,
          },
          outputDir,
          {
            cpuCores: 2,
            memoryBytes: 4 * 1024 ** 3,
            wallClockMs: this.opts.wallClockMs,
          },
          jobSignal.signal,
        );

        // 4. validating
        await heartbeat('validating');
        if (candidate.artifacts.length === 0) {
          throw new HostPreviewError({
            code: ERROR_CODES.INVALID_CONVERSION_OUTPUT,
            message: '转换器未产出任何 artifact',
            httpStatus: 500,
            retryable: false,
          });
        }

        // 5. publishing：上传 artifact 并构建正式 manifest
        await heartbeat('publishing');
        const artifactDescriptors: Array<{
          artifact_id: string;
          media_type: string;
          size_bytes: number;
          sha256: string;
          role: string;
          object_key: string;
          relative_path: string;
        }> = [];

        for (const art of candidate.artifacts) {
          const bytes = await readFile(join(outputDir, art.relativePath));
          const artifactId = `art_${randomUUID()}`;
          const objectKey = `${this.opts.artifactPrefix}/${preview.namespace}/${preview.tenantId}/previews/${preview.id}/jobs/${job.id}/artifacts/${artifactId}`;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
          await this.opts.artifactStorage.put(
            objectKey,
            stream,
            art.sizeBytes,
            art.sha256,
            jobSignal.signal,
          );
          artifactDescriptors.push({
            artifact_id: artifactId,
            media_type: art.mediaType,
            size_bytes: art.sizeBytes,
            sha256: art.sha256,
            role: art.role,
            object_key: objectKey,
            relative_path: art.relativePath,
          });
        }

        const runnerManifest = candidate.manifest as Record<string, unknown>;
        const defaultReprId =
          (runnerManifest['default_representation_id'] as string | undefined) ??
          'text';

        // 把 runner 里给的 entry_artifact / entry_artifact_relative_path 换成真正的 artifact_id，并规范化 kind
        const representations = (
          (runnerManifest['representations'] as Array<
            Record<string, unknown>
          >) ?? []
        ).map((rep) => {
          const rel = rep['entry_artifact_relative_path'] as string | undefined;
          const entryRef = (rep['entry_artifact'] ?? rep['entry_artifact_id']) as string | undefined;
          let found = rel
            ? artifactDescriptors.find((a) => a.relative_path === rel)
            : undefined;
          if (!found && entryRef) {
            found = artifactDescriptors.find(
              (a) => a.artifact_id === entryRef || a.role === 'entry',
            );
          }
          if (!found) {
            found = artifactDescriptors.find((a) => a.role === 'entry');
          }

          let kind = rep['kind'] as string;
          if (kind === 'plain_text' || kind === 'structured_text') kind = 'text';
          else if (kind === 'image_gallery' || kind === 'image') kind = 'gallery';

          const cleaned: Record<string, unknown> = { ...rep, kind };
          delete cleaned['entry_artifact_relative_path'];
          cleaned['entry_artifact_id'] = found?.artifact_id ?? null;
          return cleaned;
        });

        if (this.opts.sourceProvider.isAvailable) {
          const available = await this.opts.sourceProvider.isAvailable(
            {
              resourceKey: source.resourceKey,
              version: source.sourceVersion,
              filename: source.filename,
              extension: source.extension,
              sizeBytes: source.sizeBytes,
              ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
              handle: {},
            },
            jobSignal.signal,
          );
          if (!available) {
            throw HostErrors.sourceUnavailable('源已失效，放弃发布');
          }
        }

        let finalAvailability: 'ready' | 'partial' =
          (runnerManifest['availability'] as string) === 'partial'
            ? 'partial'
            : 'ready';
        for (const repr of representations) {
          if (
            repr.completeness === 'partial' &&
            repr.affects_completeness !== false
          ) {
            finalAvailability = 'partial';
            break;
          }
        }

        const finalManifest = {
          schema_version: MANIFEST_SCHEMA_VERSION,
          preview_id: preview.id,
          source_id: source.id,
          profile_id: preview.profileId,
          published_revision: (preview.publishedRevision ?? 0) + 1,
          source: {
            name: source.filename,
            extension: source.extension,
            size_bytes: source.sizeBytes,
          },
          default_representation_id: defaultReprId,
          availability: finalAvailability,
          representations,
          artifacts: artifactDescriptors.map(
            ({ relative_path: _rp, ...rest }) => rest,
          ),
          capabilities: (runnerManifest['capabilities'] as Record<
            string,
            unknown
          >) ?? {
            search_scope: 'document',
            static_only: true,
          },
          warnings: candidate.warnings.map((w) => ({
            code: w.code,
            message: w.message,
            ...(w.scope !== undefined ? { scope: w.scope } : {}),
          })),
        };

        await this.opts.store.publishResult({
          previewId: preview.id,
          jobId: job.id,
          leaseToken: job.leaseToken!,
          manifest: finalManifest,
          availability: finalAvailability,
        });

        this.opts.logger.log('info', 'orchestrator.published', {
          previewId: preview.id,
          jobId: job.id,
        });
      } finally {
        clearInterval(heartbeatTimer);
        await rm(workDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    } catch (err) {
      const payload: PreviewErrorPayload = isHostPreviewError(err)
        ? err.toPayload()
        : HostErrors.unknown(err).toPayload();

      // 基础设施错误允许重试；确定性错误不重试
      const allowRetry =
        payload.code === ERROR_CODES.SERVICE_UNAVAILABLE ||
        payload.code === ERROR_CODES.NETWORK_ERROR;

      await this.opts.store
        .failOrRetry({
          jobId: job.id,
          leaseToken: job.leaseToken!,
          error: payload,
          allowRetry,
        })
        .catch(() => undefined);

      this.opts.logger.log('warn', 'orchestrator.job_failed', {
        jobId: job.id,
        code: payload.code,
        message: payload.message,
      });
    } finally {
      clearTimeout(wallTimer);
      this.activeJobs.delete(job.id);
      this.notifyStateChanged(job.previewId);
    }
  }
}

async function readWebStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}
