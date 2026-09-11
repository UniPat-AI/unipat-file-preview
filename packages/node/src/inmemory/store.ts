import { randomUUID } from 'node:crypto';
import type {
  EnsurePreviewInput,
  EnsurePreviewResult,
  JobRow,
  PreviewRecordRow,
  PublishResultInput,
  ResultRow,
  SourceRow,
  Store,
} from '../ports.js';
import { HostErrors } from '../errors.js';
import type { FileRef, PreviewErrorPayload } from '@unipat/file-preview-contracts';

interface MutableJob {
  row: JobRow;
}
interface MutableRecord {
  row: PreviewRecordRow;
}
interface MutableResult {
  row: ResultRow;
}

/**
 * 内存版 Store。**只**支持单进程单节点，不模拟真实事务，仅够跑通端到端。
 */
export class InMemoryStore implements Store {
  private readonly sources = new Map<string, SourceRow>();
  private readonly sourceByKey = new Map<string, string>();
  private readonly previews = new Map<string, MutableRecord>();
  private readonly previewByKey = new Map<string, string>();
  private readonly jobs = new Map<string, MutableJob>();
  private readonly results = new Map<string, MutableResult>();
  private readonly claimQueue: string[] = [];
  private readonly deadLetterJobs = new Set<string>();
  private readonly nextAttemptAt = new Map<string, number>();
  private readonly previewExpireAt = new Map<string, number>();
  private readonly maxPublishedRevision = new Map<string, number>();
  private readonly namespace: string;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private readonly onArtifactCleanup:
    | ((objectKeys: readonly string[]) => Promise<void> | void)
    | null;

  constructor(
    options: {
      namespace?: string;
      maxAttempts?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
      onArtifactCleanup?: (
        objectKeys: readonly string[],
      ) => Promise<void> | void;
    } = {},
  ) {
    this.namespace = options.namespace ?? 'default';
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.onArtifactCleanup = options.onArtifactCleanup ?? null;
  }

  async findPreview(input: {
    namespace: string;
    tenantId: string;
    file: FileRef;
    profileId: string;
  }): Promise<{ preview: PreviewRecordRow; source: SourceRow } | null> {
    const sourceKey = makeSourceKey(
      input.namespace,
      input.tenantId,
      input.file.resourceKey,
      input.file.version,
    );
    const sourceId = this.sourceByKey.get(sourceKey);
    if (!sourceId) return null;
    const source = this.sources.get(sourceId);
    if (!source) return null;
    const previewKey = `${sourceId}::${input.profileId}`;
    const previewId = this.previewByKey.get(previewKey);
    if (!previewId) return null;
    const preview = this.previews.get(previewId)?.row;
    if (!preview) return null;
    return { preview, source };
  }

  async ensurePreview(input: EnsurePreviewInput): Promise<EnsurePreviewResult> {
    const sourceKey = makeSourceKey(
      input.namespace,
      input.tenantId,
      input.file.resourceKey,
      input.file.version,
    );
    let sourceId = this.sourceByKey.get(sourceKey);
    if (!sourceId) {
      sourceId = `src_${randomUUID()}`;
      const now = new Date().toISOString();
      const row: SourceRow = {
        id: sourceId,
        namespace: input.namespace,
        tenantId: input.tenantId,
        resourceKey: input.file.resourceKey,
        sourceVersion: input.file.version,
        filename: input.source.filename,
        extension: input.source.extension,
        sizeBytes: input.source.sizeBytes,
        expectedSha256: input.source.expectedSha256 ?? null,
        verifiedSha256: null,
        status: 'active',
        createdAt: now,
        invalidatedAt: null,
      };
      this.sources.set(sourceId, row);
      this.sourceByKey.set(sourceKey, sourceId);
    } else {
      const existing = this.sources.get(sourceId)!;
      if (existing.sizeBytes !== input.source.sizeBytes) {
        throw HostErrors.sourceChanged();
      }
      if (existing.status !== 'active') {
        throw HostErrors.sourceUnavailable();
      }
    }
    const source = this.sources.get(sourceId)!;

    const previewKey = `${sourceId}::${input.profileId}`;
    let previewId = this.previewByKey.get(previewKey);
    let createdJob: JobRow | null = null;

    if (!previewId) {
      previewId = `prv_${randomUUID()}`;
      const record: PreviewRecordRow = {
        id: previewId,
        namespace: input.namespace,
        tenantId: input.tenantId,
        sourceId,
        profileId: input.profileId,
        generation: 1,
        currentJobId: null,
        executionState: 'queued',
        revision: 1,
        publishedResultId: null,
        publishedRevision: null,
        cleanupState: 'idle',
        lastError: null,
      };
      this.previews.set(previewId, { row: record });
      this.previewByKey.set(previewKey, previewId);
      createdJob = this.createJobInternal(record, 1);
    } else {
      const record = this.previews.get(previewId)!.row;
      if (
        record.executionState === 'succeeded' ||
        record.executionState === 'failed' ||
        record.executionState === 'cancelled'
      ) {
        // 已终态：不自动重排队，等待人工 retry
      } else if (!record.currentJobId) {
        createdJob = this.createJobInternal(record, record.generation);
      }
    }

    return {
      preview: this.previews.get(previewId)!.row,
      source,
      createdJob,
    };
  }

  async getPreview(id: string): Promise<PreviewRecordRow | null> {
    return this.previews.get(id)?.row ?? null;
  }

  async getSource(id: string): Promise<SourceRow | null> {
    return this.sources.get(id) ?? null;
  }

  async getResult(
    previewId: string,
    publishedRevision: number,
  ): Promise<ResultRow | null> {
    for (const { row } of this.results.values()) {
      if (
        row.previewId === previewId &&
        row.publishedRevision === publishedRevision
      ) {
        return row;
      }
    }
    return null;
  }

  async claimJob(input: {
    workerId: string;
    namespace: string;
    leaseDurationMs: number;
  }): Promise<JobRow | null> {
    const nowTs = Date.now();
    const requeue: string[] = [];
    let picked: string | null = null;
    while (this.claimQueue.length) {
      const jobId = this.claimQueue.shift()!;
      const job = this.jobs.get(jobId);
      if (!job) continue;
      if (job.row.namespace !== input.namespace) {
        requeue.push(jobId);
        continue;
      }
      if (job.row.status !== 'queued') continue;
      const dueAt = this.nextAttemptAt.get(jobId) ?? 0;
      if (dueAt > nowTs) {
        requeue.push(jobId);
        continue;
      }
      picked = jobId;
      break;
    }
    for (const j of requeue) this.claimQueue.push(j);
    if (!picked) return null;
    const job = this.jobs.get(picked)!;
    const now = new Date();
    const leaseToken = randomUUID();
    const updated: JobRow = {
      ...job.row,
      status: 'running',
      stage: 'fetching',
      leaseOwner: input.workerId,
      leaseToken,
      leaseExpiresAt: new Date(
        now.getTime() + input.leaseDurationMs,
      ).toISOString(),
      startedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
    };
    job.row = updated;
    this.updatePreviewExecution(updated.previewId, 'running');
    return updated;
  }

  async heartbeat(input: {
    jobId: string;
    leaseToken: string;
    leaseDurationMs: number;
    stage: JobRow['stage'];
    progress: JobRow['progress'];
  }): Promise<boolean> {
    const job = this.jobs.get(input.jobId);
    if (!job) return false;
    if (job.row.leaseToken !== input.leaseToken) return false;
    const nowTs = Date.now();
    if (job.row.leaseExpiresAt && new Date(job.row.leaseExpiresAt).getTime() <= nowTs) {
      return false;
    }
    const now = new Date(nowTs);
    job.row = {
      ...job.row,
      stage: input.stage,
      progress: input.progress,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(
        now.getTime() + input.leaseDurationMs,
      ).toISOString(),
    };
    this.bumpPreviewRevision(job.row.previewId);
    return true;
  }

  async publishResult(input: PublishResultInput): Promise<ResultRow> {
    const job = this.jobs.get(input.jobId);
    if (!job) throw HostErrors.resourceNotFound();
    if (job.row.leaseToken !== input.leaseToken) {
      throw HostErrors.protocolError('租约失效，无法发布');
    }
    const previewSlot = this.previews.get(input.previewId);
    if (!previewSlot) throw HostErrors.resourceNotFound();

    const source = this.sources.get(previewSlot.row.sourceId);
    if (!source || source.status !== 'active') {
      throw HostErrors.sourceUnavailable('源不可用，拒绝发布');
    }
    if (previewSlot.row.cleanupState !== 'idle') {
      throw HostErrors.clearInProgress('正在清理中，拒绝发布');
    }
    if (previewSlot.row.currentJobId !== input.jobId) {
      throw HostErrors.protocolError('任务轮次已失效，拒绝发布');
    }
    if (previewSlot.row.generation !== job.row.generation) {
      throw HostErrors.protocolError('generation 不匹配，拒绝发布');
    }
    if (job.row.leaseExpiresAt && new Date(job.row.leaseExpiresAt).getTime() <= Date.now()) {
      throw HostErrors.protocolError('租约已过期，拒绝发布');
    }

    const prevMax = this.maxPublishedRevision.get(input.previewId) ?? (previewSlot.row.publishedRevision ?? 0);
    const nextRevision = prevMax + 1;
    this.maxPublishedRevision.set(input.previewId, nextRevision);

    const resultId = `res_${randomUUID()}`;
    const row: ResultRow = {
      id: resultId,
      previewId: input.previewId,
      jobId: input.jobId,
      publishedRevision: nextRevision,
      manifest: input.manifest,
      availability: input.availability,
      publishedAt: new Date().toISOString(),
    };
    this.results.set(resultId, { row });
    job.row = {
      ...job.row,
      status: 'succeeded',
      stage: 'publishing',
      finishedAt: new Date().toISOString(),
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    previewSlot.row = {
      ...previewSlot.row,
      executionState: 'succeeded',
      revision: previewSlot.row.revision + 1,
      publishedResultId: resultId,
      publishedRevision: nextRevision,
      currentJobId: null,
      lastError: null,
    };
    // 默认 24h TTL；调用方可通过 markPreviewExpireAt 覆盖
    this.previewExpireAt.set(input.previewId, Date.now() + 24 * 60 * 60 * 1000);
    return row;
  }

  async failOrRetry(input: {
    jobId: string;
    leaseToken: string;
    error: PreviewErrorPayload;
    allowRetry: boolean;
  }): Promise<{ nextJob: JobRow | null }> {
    const job = this.jobs.get(input.jobId);
    if (!job) return { nextJob: null };
    if (job.row.leaseToken !== input.leaseToken) return { nextJob: null };
    job.row = {
      ...job.row,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: input.error,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    const previewSlot = this.previews.get(job.row.previewId);
    if (!previewSlot) return { nextJob: null };

    if (input.allowRetry && job.row.attemptNo < this.maxAttempts) {
      const nextAttempt = job.row.attemptNo + 1;
      const nextJob = this.createJobInternal(
        previewSlot.row,
        job.row.generation,
        nextAttempt,
      );
      // 指数退避（base * 2^(attempt-1) + jitter）+ 上限
      const exp = Math.min(
        this.baseBackoffMs * 2 ** (nextAttempt - 2),
        this.maxBackoffMs,
      );
      const jitter = Math.floor(Math.random() * Math.min(exp, 1000));
      this.nextAttemptAt.set(nextJob.id, Date.now() + exp + jitter);
      return { nextJob };
    }

    // 超出最大重试次数 → 转入死信队列
    if (input.allowRetry && job.row.attemptNo >= this.maxAttempts) {
      this.deadLetterJobs.add(job.row.id);
    }

    previewSlot.row = {
      ...previewSlot.row,
      executionState: 'failed',
      currentJobId: null,
      lastError: input.error,
      revision: previewSlot.row.revision + 1,
    };
    return { nextJob: null };
  }

  async cancelGeneration(input: {
    previewId: string;
    actorUserId: string;
  }): Promise<boolean> {
    const slot = this.previews.get(input.previewId);
    if (!slot) return false;
    const currentJobId = slot.row.currentJobId;
    if (currentJobId) {
      const job = this.jobs.get(currentJobId);
      if (
        job &&
        (job.row.status === 'queued' || job.row.status === 'running')
      ) {
        job.row = {
          ...job.row,
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          leaseToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        };
      }
    }
    slot.row = {
      ...slot.row,
      executionState: 'cancelled',
      currentJobId: null,
      revision: slot.row.revision + 1,
    };
    return true;
  }

  async enqueueRetry(input: {
    previewId: string;
    actorUserId: string;
  }): Promise<JobRow> {
    const slot = this.previews.get(input.previewId);
    if (!slot) throw HostErrors.resourceNotFound();
    if (slot.row.currentJobId) {
      const running = this.jobs.get(slot.row.currentJobId);
      if (
        running &&
        (running.row.status === 'queued' || running.row.status === 'running')
      ) {
        throw HostErrors.alreadyRunning();
      }
    }
    if (slot.row.cleanupState !== 'idle') {
      throw HostErrors.clearInProgress();
    }
    const nextGeneration = slot.row.generation + 1;
    slot.row = {
      ...slot.row,
      generation: nextGeneration,
      executionState: 'queued',
      revision: slot.row.revision + 1,
      lastError: null,
    };
    return this.createJobInternal(slot.row, nextGeneration);
  }

  async clearResults(input: {
    previewId: string;
    actorUserId: string;
  }): Promise<void> {
    const slot = this.previews.get(input.previewId);
    if (!slot) throw HostErrors.resourceNotFound();

    // 终止正在运行的 job
    if (slot.row.currentJobId) {
      const job = this.jobs.get(slot.row.currentJobId);
      if (
        job &&
        (job.row.status === 'queued' || job.row.status === 'running')
      ) {
        job.row = {
          ...job.row,
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          leaseToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        };
      }
    }

    const artifactKeys: string[] = [];
    for (const [id, r] of this.results) {
      if (r.row.previewId === input.previewId) {
        const arts = (
          r.row.manifest as { artifacts?: Array<Record<string, unknown>> }
        ).artifacts;
        if (Array.isArray(arts)) {
          for (const a of arts) {
            const key = a['object_key'];
            if (typeof key === 'string') artifactKeys.push(key);
          }
        }
        this.results.delete(id);
      }
    }

    if (artifactKeys.length > 0 && this.onArtifactCleanup) {
      try {
        await this.onArtifactCleanup(artifactKeys);
      } catch {
        // ignore
      }
    }

    slot.row = {
      ...slot.row,
      cleanupState: 'idle',
      executionState: 'cancelled',
      generation: slot.row.generation + 1,
      publishedResultId: null,
      publishedRevision: null,
      currentJobId: null,
      revision: slot.row.revision + 1,
    };
  }

  // ------------------------------------------------------------
  // 内部方法
  // ------------------------------------------------------------

  private createJobInternal(
    record: PreviewRecordRow,
    generation: number,
    attemptNo = 1,
  ): JobRow {
    const jobId = `job_${randomUUID()}`;
    const now = new Date().toISOString();
    const row: JobRow = {
      id: jobId,
      namespace: record.namespace,
      tenantId: record.tenantId,
      kind: 'convert',
      operationId: `${record.id}::gen${generation}::att${attemptNo}`,
      previewId: record.id,
      generation,
      attemptNo,
      status: 'queued',
      stage: 'queued',
      progress: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      queuedAt: now,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      error: null,
    };
    this.jobs.set(jobId, { row });
    this.claimQueue.push(jobId);
    const slot = this.previews.get(record.id);
    if (slot) {
      slot.row = {
        ...slot.row,
        currentJobId: jobId,
      };
    }
    return row;
  }

  private updatePreviewExecution(
    previewId: string,
    state: PreviewRecordRow['executionState'],
  ): void {
    const slot = this.previews.get(previewId);
    if (!slot) return;
    slot.row = {
      ...slot.row,
      executionState: state,
      revision: slot.row.revision + 1,
    };
  }

  private bumpPreviewRevision(previewId: string): void {
    const slot = this.previews.get(previewId);
    if (!slot) return;
    slot.row = { ...slot.row, revision: slot.row.revision + 1 };
  }

  async listDeadLetterJobs(input: {
    namespace: string;
    limit?: number;
  }): Promise<readonly JobRow[]> {
    const out: JobRow[] = [];
    for (const id of this.deadLetterJobs) {
      const job = this.jobs.get(id);
      if (!job) continue;
      if (job.row.namespace !== input.namespace) continue;
      out.push(job.row);
      if (input.limit && out.length >= input.limit) break;
    }
    return out;
  }

  /** 标记 preview 何时过期（供后续 sweepExpired 扫描）。 */
  markPreviewExpireAt(previewId: string, expireAtMs: number): void {
    this.previewExpireAt.set(previewId, expireAtMs);
  }

  async sweepExpired(input: {
    namespace: string;
    now: Date;
    ttlMs: number;
  }): Promise<readonly string[]> {
    const removed: string[] = [];
    const artifactKeys: string[] = [];
    const nowTs = input.now.getTime();
    for (const [previewId, slot] of this.previews) {
      if (slot.row.namespace !== input.namespace) continue;
      const explicit = this.previewExpireAt.get(previewId);
      const dueAt =
        explicit ??
        (slot.row.executionState === 'succeeded' ||
        slot.row.executionState === 'failed' ||
        slot.row.executionState === 'cancelled'
          ? nowTs + input.ttlMs
          : Infinity);
      if (dueAt > nowTs) continue;
      // 收集要清理的 artifact object_key
      for (const [rid, r] of this.results) {
        if (r.row.previewId !== previewId) continue;
        const arts = (
          r.row.manifest as { artifacts?: Array<Record<string, unknown>> }
        ).artifacts;
        if (Array.isArray(arts)) {
          for (const a of arts) {
            const key = a['object_key'];
            if (typeof key === 'string') artifactKeys.push(key);
          }
        }
        this.results.delete(rid);
      }
      for (const [jid, j] of this.jobs) {
        if (j.row.previewId === previewId) {
          this.jobs.delete(jid);
          this.deadLetterJobs.delete(jid);
          this.nextAttemptAt.delete(jid);
        }
      }
      this.previews.delete(previewId);
      this.previewExpireAt.delete(previewId);
      for (const [k, pid] of this.previewByKey) {
        if (pid === previewId) {
          this.previewByKey.delete(k);
        }
      }
      removed.push(previewId);
    }
    if (artifactKeys.length > 0 && this.onArtifactCleanup) {
      try {
        await this.onArtifactCleanup(artifactKeys);
      } catch {
        // 忽略 cleanup 错误：不阻塞 sweep 结果返回
      }
    }
    return removed;
  }
}

function makeSourceKey(
  namespace: string,
  tenantId: string,
  resourceKey: string,
  version: string,
): string {
  return `${namespace}::${tenantId}::${resourceKey}@${version}`;
}
