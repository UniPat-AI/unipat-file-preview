import type { ErrorCode, PreviewErrorPayload } from './contracts.js';
import { ERROR_CODES } from './contracts.js';

export class PreviewError extends Error implements PreviewErrorPayload {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(payload: PreviewErrorPayload) {
    super(payload.message);
    this.name = 'PreviewError';
    this.code = payload.code;
    this.retryable = payload.retryable;
    if (payload.requestId !== undefined) this.requestId = payload.requestId;
    if (payload.details !== undefined) this.details = payload.details;
  }
}

export function isPreviewError(value: unknown): value is PreviewError {
  return value instanceof PreviewError;
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ERROR_CODES.SERVICE_UNAVAILABLE,
  ERROR_CODES.NETWORK_ERROR,
  ERROR_CODES.PREVIEW_NOT_READY,
]);

interface ServerErrorShape {
  code?: string | undefined;
  message?: string | undefined;
  retryable?: boolean | undefined;
  details?: Readonly<Record<string, unknown>> | undefined;
}

function isKnownErrorCode(code: string): code is ErrorCode {
  return (Object.values(ERROR_CODES) as readonly string[]).includes(code);
}

export function normalizePreviewError(
  raw: unknown,
  fallback: { requestId?: string } = {},
): PreviewError {
  if (isPreviewError(raw)) return raw;

  if (isAbortError(raw)) {
    return new PreviewError({
      code: ERROR_CODES.REQUEST_ABORTED,
      message: '请求已被取消',
      retryable: false,
      ...(fallback.requestId !== undefined
        ? { requestId: fallback.requestId }
        : {}),
    });
  }

  const shape = extractErrorShape(raw);
  const code: ErrorCode =
    shape.code && isKnownErrorCode(shape.code)
      ? shape.code
      : ERROR_CODES.UNKNOWN_ERROR;

  const message = shape.message || defaultMessageFor(code);
  const retryable = shape.retryable ?? RETRYABLE_BY_DEFAULT.has(code);

  return new PreviewError({
    code,
    message,
    retryable,
    ...(fallback.requestId !== undefined
      ? { requestId: fallback.requestId }
      : {}),
    ...(shape.details !== undefined ? { details: shape.details } : {}),
  });
}

function isAbortError(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as { name?: unknown; code?: unknown };
  return record.name === 'AbortError' || record.code === 'ABORT_ERR';
}

function extractErrorShape(raw: unknown): ServerErrorShape {
  if (typeof raw !== 'object' || raw === null) {
    return { message: typeof raw === 'string' ? raw : undefined };
  }
  const record = raw as Record<string, unknown>;
  const inner = (record['error'] as ServerErrorShape | undefined) ?? undefined;
  const source: Record<string, unknown> = inner
    ? (inner as unknown as Record<string, unknown>)
    : record;

  return {
    code:
      typeof source['code'] === 'string'
        ? (source['code'] as string)
        : undefined,
    message:
      typeof source['message'] === 'string'
        ? (source['message'] as string)
        : undefined,
    retryable:
      typeof source['retryable'] === 'boolean'
        ? (source['retryable'] as boolean)
        : undefined,
    details:
      typeof source['details'] === 'object' && source['details'] !== null
        ? (source['details'] as Readonly<Record<string, unknown>>)
        : undefined,
  };
}

function defaultMessageFor(code: ErrorCode): string {
  switch (code) {
    case ERROR_CODES.AUTH_REQUIRED:
      return '需要登录';
    case ERROR_CODES.RESOURCE_NOT_FOUND:
      return '文件不存在或无权访问';
    case ERROR_CODES.ACTION_FORBIDDEN:
      return '当前身份无权执行该操作';
    case ERROR_CODES.SOURCE_UNAVAILABLE:
      return '源文件已失效';
    case ERROR_CODES.SOURCE_CHANGED:
      return '源文件字节已发生变化';
    case ERROR_CODES.SOURCE_TOO_LARGE:
      return '源文件超过预览大小上限';
    case ERROR_CODES.PREVIEW_NOT_READY:
      return '预览尚未就绪';
    case ERROR_CODES.ALREADY_RUNNING:
      return '已有进行中的任务';
    case ERROR_CODES.CLEAR_IN_PROGRESS:
      return '结果正在清理中';
    case ERROR_CODES.RESULT_EXPIRED:
      return '结果已过期，请重新获取清单';
    case ERROR_CODES.SHEET_RANGE_NOT_SATISFIABLE:
      return '表格范围不合法';
    case ERROR_CODES.WINDOW_READ_LIMIT:
      return '表格窗口过大，请缩小范围';
    case ERROR_CODES.UNSUPPORTED_FORMAT:
      return '不支持的格式';
    case ERROR_CODES.TYPE_MISMATCH:
      return '文件类型与扩展名不匹配';
    case ERROR_CODES.PASSWORD_REQUIRED:
      return '文件受密码保护';
    case ERROR_CODES.CORRUPT_FILE:
      return '文件已损坏';
    case ERROR_CODES.INVALID_CONVERSION_OUTPUT:
      return '转换结果无效';
    case ERROR_CODES.IMAGE_CODEC_UNSUPPORTED:
      return '暂不支持的编解码格式';
    case ERROR_CODES.RESOURCE_LIMIT_EXCEEDED:
      return '任务资源占用超限';
    case ERROR_CODES.CONVERSION_TIMEOUT:
      return '转换超时';
    case ERROR_CODES.IDEMPOTENCY_CONFLICT:
      return '幂等键冲突';
    case ERROR_CODES.REQUEST_IN_PROGRESS:
      return '同键请求仍在处理';
    case ERROR_CODES.MANIFEST_VERSION_UNSUPPORTED:
      return '清单版本不受支持，请升级组件';
    case ERROR_CODES.SERVICE_UNAVAILABLE:
      return '服务暂不可用';
    case ERROR_CODES.STATIC_ASSET_MISSING:
      return '静态资源缺失';
    case ERROR_CODES.STATIC_ASSET_VERSION_MISMATCH:
      return '静态资源版本不匹配';
    case ERROR_CODES.STYLE_BLOCKED_BY_HOST:
      return '样式被宿主 CSP 阻止';
    case ERROR_CODES.NETWORK_ERROR:
      return '网络错误';
    case ERROR_CODES.REQUEST_ABORTED:
      return '请求已被取消';
    case ERROR_CODES.PROTOCOL_ERROR:
      return '响应格式与协议不符';
    case ERROR_CODES.UNKNOWN_ERROR:
      return '未知错误';
    default:
      return '未知错误';
  }
}
