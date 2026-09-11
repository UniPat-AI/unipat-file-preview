export interface FileRef {
  readonly resourceKey: string;
  readonly version: string;
}

export type ExecutionState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type Availability = 'none' | 'ready' | 'partial';

export type JobStage =
  | 'queued'
  | 'fetching'
  | 'inspecting'
  | 'converting'
  | 'publishing'
  | 'ready'
  | 'failed';

export interface PreviewProgress {
  readonly current: number;
  readonly total: number | null;
  readonly unit: 'bytes' | 'pages' | 'frames' | 'sheets' | 'rows';
  readonly message?: string;
}

export interface PreviewPermissions {
  readonly downloadOriginal: boolean;
  readonly print: boolean;
  readonly copy: boolean;
  readonly retry: boolean;
}

export interface PreviewWarning {
  readonly code: string;
  readonly message: string;
  readonly scope?: string;
}

export interface PreviewState {
  readonly previewId: string;
  readonly fileRef: FileRef;
  readonly profileId: string;
  readonly generation: number;
  readonly executionState: ExecutionState;
  readonly availability: Availability;
  readonly stage: JobStage;
  readonly progress: PreviewProgress | null;
  readonly revision: number;
  readonly publishedRevision: number | null;
  readonly isPreviousResult: boolean;
  readonly permissions: PreviewPermissions;
  readonly warnings: readonly PreviewWarning[];
  readonly error: PreviewErrorPayload | null;
  readonly retryAfterMs: number | null;
}

export interface PreviewErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly requestId?: string;
}

export interface ManifestSourceInfo {
  readonly name: string;
  readonly extension: string;
  readonly sizeBytes: number;
}

export interface ArtifactDescriptor {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly role: 'entry' | 'chunk' | 'thumbnail' | 'frame' | 'auxiliary';
}

export type RepresentationKind =
  | 'pdf'
  | 'table'
  | 'gallery'
  | 'html'
  | 'text'
  | 'notebook'
  | string;

export interface Representation {
  readonly id: string;
  readonly kind: RepresentationKind;
  readonly label: string;
  readonly status: 'ready' | 'partial' | 'failed';
  readonly completeness: 'complete' | 'partial';
  readonly affectsCompleteness?: boolean;
  readonly entryArtifactId: string | null;
}

export interface Manifest {
  readonly schemaVersion: string;
  readonly previewId: string;
  readonly profileId: string;
  readonly publishedRevision: number;
  readonly source: ManifestSourceInfo;
  readonly defaultRepresentationId: string;
  readonly availability: 'ready' | 'partial';
  readonly representations: readonly Representation[];
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly warnings: readonly PreviewWarning[];
}

export interface SheetCell {
  readonly row: number;
  readonly col: number;
  readonly type: 'string' | 'number' | 'boolean' | 'date' | 'formula' | 'error' | string;
  readonly rawValue: string | null;
  readonly displayValue: string | null;
  readonly cachedValue?: string | null;
  readonly formula?: string | null;
}

export interface SheetWindowRange {
  readonly publishedRevision: number;
  readonly sheetId: string;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

export interface SheetWindow {
  readonly sheetId: string;
  readonly range: SheetWindowRange;
  readonly cells: readonly SheetCell[];
  readonly merges: readonly string[];
  readonly coverage: {
    readonly unit: 'rows' | 'cells';
    readonly shown: number;
    readonly total: number | null;
    readonly scope?: string;
  };
  readonly warnings: readonly PreviewWarning[];
}

export const CLIENT_POLL_MIN_INTERVAL_MS = 1000;
export const CLIENT_POLL_MAX_INTERVAL_MS = 10000;

export interface GetStateInput {
  readonly file: FileRef;
  readonly profileId?: string;
  readonly signal?: AbortSignal;
}

export interface FetchManifestInput {
  readonly previewId: string;
  readonly publishedRevision: number;
  readonly etag?: string;
  readonly signal?: AbortSignal;
}

export interface FetchArtifactInput {
  readonly previewId: string;
  readonly publishedRevision: number;
  readonly artifactId: string;
  readonly etag?: string;
  readonly range?: { start: number; endInclusive: number };
  readonly signal?: AbortSignal;
}

export interface PreviewEventEnvelope {
  readonly eventId: number;
  readonly previewId: string;
  readonly type: 'preview-state' | 'heartbeat';
  readonly state: PreviewState | null;
  readonly emittedAt: string;
}

export const SHEET_WINDOW_MAX_ROWS = 500;
export const SHEET_WINDOW_MAX_COLS = 100;

export const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  ACTION_FORBIDDEN: 'ACTION_FORBIDDEN',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  SOURCE_CHANGED: 'SOURCE_CHANGED',
  SOURCE_TOO_LARGE: 'SOURCE_TOO_LARGE',
  PREVIEW_NOT_READY: 'PREVIEW_NOT_READY',
  ALREADY_RUNNING: 'ALREADY_RUNNING',
  CLEAR_IN_PROGRESS: 'CLEAR_IN_PROGRESS',
  RESULT_EXPIRED: 'RESULT_EXPIRED',
  SHEET_RANGE_NOT_SATISFIABLE: 'SHEET_RANGE_NOT_SATISFIABLE',
  WINDOW_READ_LIMIT: 'WINDOW_READ_LIMIT',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  PASSWORD_REQUIRED: 'PASSWORD_REQUIRED',
  CORRUPT_FILE: 'CORRUPT_FILE',
  INVALID_CONVERSION_OUTPUT: 'INVALID_CONVERSION_OUTPUT',
  IMAGE_CODEC_UNSUPPORTED: 'IMAGE_CODEC_UNSUPPORTED',
  RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
  CONVERSION_TIMEOUT: 'CONVERSION_TIMEOUT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  MANIFEST_VERSION_UNSUPPORTED: 'MANIFEST_VERSION_UNSUPPORTED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  REQUEST_ABORTED: 'REQUEST_ABORTED',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;
