import type { PreviewErrorPayload } from './errors.js';

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
  | 'validating'
  | 'publishing';

export interface PreviewProgress {
  readonly done: number;
  readonly total: number;
  readonly unit: string;
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

/**
 * SSE 事件负载。事件名固定为 `preview-state`，data 为 PreviewState 的 snake_case 版本；
 * `id` 字段用于客户端断线续传（Last-Event-ID）。
 */
export interface PreviewEventEnvelope {
  readonly eventId: number;
  readonly previewId: string;
  readonly type: 'preview-state' | 'heartbeat';
  readonly state: PreviewState | null;
  readonly emittedAt: string;
}
