import type {
  Authorize,
  FileRef,
  PreviewErrorPayload,
} from '@unipat/file-preview-contracts';

/**
 * 5 个 Port 接口：接入方需要各自提供实现。
 * 其中 Authorize 直接复用 contracts 里的定义。
 */
export type { Authorize };

// ------------------------------------------------------------
// SourceProvider：原文件的解析、读取与可用性检查
// ------------------------------------------------------------

export interface SourceScope {
  readonly namespace: string;
  readonly tenantId: string;
}

export interface ResolvedSource {
  readonly resourceKey: string;
  readonly version: string;
  readonly filename: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly expectedSha256?: string;
  /** 项目适配器内部句柄，不能返回给浏览器 */
  readonly handle: Readonly<Record<string, unknown>>;
}

export interface SourceRange {
  readonly start: number;
  readonly endInclusive: number;
}

export interface SourceReadResult {
  readonly stream: ReadableStream<Uint8Array>;
  readonly sizeBytes: number;
  readonly version: string;
}

export interface SourceProvider {
  resolve(
    scope: SourceScope,
    file: FileRef,
    signal: AbortSignal,
  ): Promise<ResolvedSource>;

  open(
    source: ResolvedSource,
    options: { signal: AbortSignal; range?: SourceRange },
  ): Promise<SourceReadResult>;

  isAvailable(source: ResolvedSource, signal: AbortSignal): Promise<boolean>;
}

// ------------------------------------------------------------
// ArtifactStorage：派生结果对象存储
// ------------------------------------------------------------

export interface ArtifactStat {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mediaType: string;
}

export interface ArtifactPutResult {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ArtifactObjectSummary {
  readonly key: string;
  readonly sizeBytes: number;
}

export interface ArtifactListPage {
  readonly objects: readonly ArtifactObjectSummary[];
  readonly nextCursor: string | null;
}

export interface ArtifactStorage {
  stat(key: string, signal: AbortSignal): Promise<ArtifactStat | null>;

  openRange(
    key: string,
    start: number,
    endInclusive: number,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;

  put(
    key: string,
    stream: ReadableStream<Uint8Array>,
    expectedSize: number,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<ArtifactPutResult>;

  delete(key: string, signal: AbortSignal): Promise<boolean>;

  list(
    prefix: string,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<ArtifactListPage>;
}

// ------------------------------------------------------------
// Runner：转换器（受限容器）
// ------------------------------------------------------------

export interface RunnerLimits {
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly wallClockMs: number;
}

export interface RunnerInputHandle {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface RunnerJobInput {
  readonly jobId: string;
  readonly previewId: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly profileId: string;
  readonly profileConfig: Readonly<Record<string, unknown>>;
  readonly source: {
    readonly filename: string;
    readonly extension: string;
    readonly sizeBytes: number;
  };
}

export interface CandidateArtifact {
  readonly relativePath: string;
  readonly role: 'entry' | 'chunk' | 'thumbnail' | 'frame' | 'auxiliary';
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface CandidateResult {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly CandidateArtifact[];
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
    readonly scope?: string;
  }[];
}

export interface RunnerCapabilities {
  readonly protocolVersions: readonly string[];
  readonly imageDigest: string;
  readonly fontDigest: string;
  readonly supportedFormats: readonly string[];
}

export interface Runner {
  run(
    input: RunnerJobInput,
    readOnlySource: RunnerInputHandle,
    outputDirectory: string,
    limits: RunnerLimits,
    signal: AbortSignal,
  ): Promise<CandidateResult>;

  cancel(jobId: string): Promise<boolean>;

  capabilities(): Promise<RunnerCapabilities>;
}

// ------------------------------------------------------------
// Store：任务和记录的持久化 + 幂等
// ------------------------------------------------------------

export type ExecutionStateDb =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type JobKind = 'convert' | 'cleanup';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type CleanupState = 'idle' | 'pending' | 'running' | 'failed';

export interface PreviewRecordRow {
  readonly id: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly profileId: string;
  readonly generation: number;
  readonly currentJobId: string | null;
  readonly executionState: ExecutionStateDb;
  readonly revision: number;
  readonly publishedResultId: string | null;
  readonly publishedRevision: number | null;
  readonly cleanupState: CleanupState;
  readonly lastError: PreviewErrorPayload | null;
}

export interface SourceRow {
  readonly id: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly resourceKey: string;
  readonly sourceVersion: string;
  readonly filename: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly expectedSha256: string | null;
  readonly verifiedSha256: string | null;
  readonly status: 'active' | 'unavailable';
  readonly createdAt: string;
  readonly invalidatedAt: string | null;
}

export interface JobRow {
  readonly id: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly kind: JobKind;
  readonly operationId: string;
  readonly previewId: string;
  readonly generation: number;
  readonly attemptNo: number;
  readonly status: JobStatus;
  readonly stage:
    | 'queued'
    | 'fetching'
    | 'inspecting'
    | 'converting'
    | 'validating'
    | 'publishing';
  readonly progress: { done: number; total: number; unit: string } | null;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly heartbeatAt: string | null;
  readonly finishedAt: string | null;
  readonly error: PreviewErrorPayload | null;
}

export interface ResultRow {
  readonly id: string;
  readonly previewId: string;
  readonly jobId: string;
  readonly publishedRevision: number;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly availability: 'ready' | 'partial';
  readonly publishedAt: string;
}

export interface EnsurePreviewInput {
  readonly namespace: string;
  readonly tenantId: string;
  readonly file: FileRef;
  readonly profileId: string;
  readonly source: ResolvedSource;
  readonly actorUserId: string;
}

export interface EnsurePreviewResult {
  readonly preview: PreviewRecordRow;
  readonly source: SourceRow;
  readonly createdJob: JobRow | null;
}

export interface PublishResultInput {
  readonly previewId: string;
  readonly jobId: string;
  readonly leaseToken: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly availability: 'ready' | 'partial';
}

export interface Store {
  findPreview(input: {
    namespace: string;
    tenantId: string;
    file: FileRef;
    profileId: string;
  }): Promise<{ preview: PreviewRecordRow; source: SourceRow } | null>;

  ensurePreview(input: EnsurePreviewInput): Promise<EnsurePreviewResult>;

  getPreview(id: string): Promise<PreviewRecordRow | null>;

  getSource(id: string): Promise<SourceRow | null>;

  getResult(
    previewId: string,
    publishedRevision: number,
  ): Promise<ResultRow | null>;

  claimJob(input: {
    workerId: string;
    namespace: string;
    leaseDurationMs: number;
  }): Promise<JobRow | null>;

  heartbeat(input: {
    jobId: string;
    leaseToken: string;
    leaseDurationMs: number;
    stage: JobRow['stage'];
    progress: JobRow['progress'];
  }): Promise<boolean>;

  publishResult(input: PublishResultInput): Promise<ResultRow>;

  failOrRetry(input: {
    jobId: string;
    leaseToken: string;
    error: PreviewErrorPayload;
    allowRetry: boolean;
  }): Promise<{ nextJob: JobRow | null }>;

  cancelGeneration(input: {
    previewId: string;
    actorUserId: string;
  }): Promise<boolean>;

  enqueueRetry(input: {
    previewId: string;
    actorUserId: string;
  }): Promise<JobRow>;

  clearResults(input: {
    previewId: string;
    actorUserId: string;
  }): Promise<void>;

  /**
   * 列出已被转入死信队列的任务（重试次数超过上限）。
   * 用于运维观测和人工介入。
   */
  listDeadLetterJobs?(input: {
    namespace: string;
    limit?: number;
  }): Promise<readonly JobRow[]>;

  /**
   * TTL 扫描：删除过期的 preview + 关联 artifact（cleanupCallback 由调用方传入）。
   * 返回被清理的 preview id 列表。
   */
  sweepExpired?(input: {
    namespace: string;
    now: Date;
    ttlMs: number;
  }): Promise<readonly string[]>;
}

// ------------------------------------------------------------
// IdempotencyStore：幂等键去重
// ------------------------------------------------------------

export interface IdempotencyRecord {
  readonly key: string;
  readonly requestHash: string;
  readonly operationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface IdempotencyStore {
  /**
   * 尝试为给定 key + requestHash 保留一次操作。
   * - 未占用：返回 { status: 'reserved', operationId }
   * - 同键同 hash：返回 { status: 'replay', operationId }
   * - 同键不同 hash：返回 { status: 'conflict' }
   * - 同键仍在处理（尚未 complete）：返回 { status: 'in_progress' }
   */
  reserve(input: {
    scope: string;
    key: string;
    requestHash: string;
    ttlMs: number;
  }): Promise<
    | { status: 'reserved'; operationId: string }
    | { status: 'replay'; operationId: string }
    | { status: 'conflict' }
    | { status: 'in_progress' }
  >;

  complete(input: {
    scope: string;
    key: string;
    operationId: string;
  }): Promise<void>;
}
