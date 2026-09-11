import type {
  Availability,
  ExecutionState,
  JobStage,
  Manifest,
  PreviewState,
  SheetWindow,
} from './contracts.js';
import { MANIFEST_SCHEMA_VERSION } from './contracts.js';
import { deepSnakeToCamel } from './case-mapping.js';
import { normalizePreviewError, PreviewError } from './errors.js';
import { ERROR_CODES } from './contracts.js';

const EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set([
  'queued', 'running', 'succeeded', 'failed', 'cancelled',
]);

const AVAILABILITIES: ReadonlySet<Availability> = new Set([
  'none', 'ready', 'partial',
]);

const JOB_STAGES: ReadonlySet<JobStage> = new Set([
  'queued', 'fetching', 'inspecting', 'converting', 'validating', 'publishing',
]);

export function decodePreviewState(raw: unknown): PreviewState {
  const camel = deepSnakeToCamel<Record<string, unknown>>(raw);

  const executionState = requireEnum<ExecutionState>(
    camel['executionState'], EXECUTION_STATES, 'executionState',
  );
  const availability = requireEnum<Availability>(
    camel['availability'], AVAILABILITIES, 'availability',
  );
  const stage = requireEnum<JobStage>(
    camel['stage'], JOB_STAGES, 'stage',
  );

  const fileRef = requireObject(camel['fileRef'], 'fileRef');
  const permissions = requireObject(camel['permissions'], 'permissions');

  return {
    previewId: requireString(camel['previewId'], 'previewId'),
    fileRef: {
      resourceKey: requireString(fileRef['resourceKey'], 'fileRef.resourceKey'),
      version: requireString(fileRef['version'], 'fileRef.version'),
    },
    profileId: requireString(camel['profileId'], 'profileId'),
    generation: requireNumber(camel['generation'], 'generation'),
    executionState,
    availability,
    stage,
    progress: normalizeProgress(camel['progress']),
    revision: requireNumber(camel['revision'], 'revision'),
    publishedRevision:
      camel['publishedRevision'] === null || camel['publishedRevision'] === undefined
        ? null
        : requireNumber(camel['publishedRevision'], 'publishedRevision'),
    isPreviousResult: Boolean(camel['isPreviousResult']),
    permissions: {
      downloadOriginal: Boolean(permissions['downloadOriginal']),
      print: Boolean(permissions['print']),
      copy: Boolean(permissions['copy']),
      retry: Boolean(permissions['retry']),
    },
    warnings: Array.isArray(camel['warnings'])
      ? (camel['warnings'] as unknown[]).map(normalizeWarning)
      : [],
    error:
      camel['error'] === null || camel['error'] === undefined
        ? null
        : normalizeErrorPayload(camel['error']),
    retryAfterMs:
      camel['retryAfterMs'] === null || camel['retryAfterMs'] === undefined
        ? null
        : requireNumber(camel['retryAfterMs'], 'retryAfterMs'),
  };
}

export function decodeManifest(raw: unknown): Manifest {
  const camel = deepSnakeToCamel<Record<string, unknown>>(raw);
  const schemaVersion = requireString(camel['schemaVersion'], 'schemaVersion');

  const [rawMajor] = schemaVersion.split('.');
  const [expectedMajor] = MANIFEST_SCHEMA_VERSION.split('.');
  if (rawMajor !== expectedMajor) {
    throw new PreviewError({
      code: ERROR_CODES.MANIFEST_VERSION_UNSUPPORTED,
      message: `清单主版本 ${schemaVersion} 与组件不匹配（期望 ${MANIFEST_SCHEMA_VERSION}）`,
      retryable: false,
    });
  }

  return camel as unknown as Manifest;
}

export function decodeSheetWindow(raw: unknown): SheetWindow {
  return deepSnakeToCamel<SheetWindow>(raw);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw protocolError(`${path} 必须为字符串`);
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw protocolError(`${path} 必须为有限数字`);
  }
  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw protocolError(`${path} 必须为对象`);
  }
  return value as Record<string, unknown>;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw protocolError(`${path} 非法：${String(value)}`);
  }
  return value as T;
}

function normalizeProgress(raw: unknown): PreviewState['progress'] {
  if (raw === null || raw === undefined) return null;
  const obj = requireObject(raw, 'progress');
  return {
    done: requireNumber(obj['done'], 'progress.done'),
    total: requireNumber(obj['total'], 'progress.total'),
    unit: requireString(obj['unit'], 'progress.unit'),
  };
}

function normalizeWarning(raw: unknown): PreviewState['warnings'][number] {
  const obj = requireObject(raw, 'warning');
  const scope = obj['scope'];
  return {
    code: requireString(obj['code'], 'warning.code'),
    message: requireString(obj['message'], 'warning.message'),
    ...(typeof scope === 'string' ? { scope } : {}),
  };
}

function normalizeErrorPayload(raw: unknown): PreviewState['error'] {
  const err = normalizePreviewError(raw);
  return {
    code: err.code,
    message: err.message,
    retryable: err.retryable,
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    ...(err.details !== undefined ? { details: err.details } : {}),
  };
}

function protocolError(message: string): PreviewError {
  return new PreviewError({
    code: ERROR_CODES.PROTOCOL_ERROR,
    message,
    retryable: false,
  });
}
