import {
  ERROR_CODES,
  type ErrorCode,
  type PreviewErrorPayload,
} from '@unipat/file-preview-contracts';

export class HostPreviewError extends Error implements PreviewErrorPayload {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(input: {
    code: ErrorCode;
    message: string;
    httpStatus: number;
    retryable?: boolean;
    requestId?: string;
    details?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message);
    this.name = 'HostPreviewError';
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.retryable = input.retryable ?? defaultRetryable(input.code);
    if (input.requestId !== undefined) this.requestId = input.requestId;
    if (input.details !== undefined) this.details = input.details;
  }

  toPayload(): PreviewErrorPayload {
    const payload: PreviewErrorPayload = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.requestId !== undefined) {
      (payload as { requestId?: string }).requestId = this.requestId;
    }
    if (this.details !== undefined) {
      (payload as { details?: Readonly<Record<string, unknown>> }).details =
        this.details;
    }
    return payload;
  }
}

const DEFAULT_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ERROR_CODES.SERVICE_UNAVAILABLE,
  ERROR_CODES.NETWORK_ERROR,
  ERROR_CODES.PREVIEW_NOT_READY,
]);

function defaultRetryable(code: ErrorCode): boolean {
  return DEFAULT_RETRYABLE.has(code);
}

export function isHostPreviewError(value: unknown): value is HostPreviewError {
  return value instanceof HostPreviewError;
}

/** 常用构造器，减少调用点样板。 */
export const HostErrors = {
  authRequired(message = '需要登录'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.AUTH_REQUIRED,
      message,
      httpStatus: 401,
      retryable: false,
    });
  },
  actionForbidden(message = '当前身份不允许该操作'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.ACTION_FORBIDDEN,
      message,
      httpStatus: 403,
      retryable: false,
    });
  },
  resourceNotFound(message = '资源不存在'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message,
      httpStatus: 404,
      retryable: false,
    });
  },
  previewNotReady(message = '结果尚未就绪'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.PREVIEW_NOT_READY,
      message,
      httpStatus: 409,
      retryable: true,
    });
  },
  alreadyRunning(message = '当前已有活动任务'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.ALREADY_RUNNING,
      message,
      httpStatus: 409,
      retryable: false,
    });
  },
  clearInProgress(message = '结果清理中'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.CLEAR_IN_PROGRESS,
      message,
      httpStatus: 409,
      retryable: false,
    });
  },
  resultExpired(message = '结果已失效'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.RESULT_EXPIRED,
      message,
      httpStatus: 410,
      retryable: false,
    });
  },
  sourceUnavailable(message = '原文件不可用'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.SOURCE_UNAVAILABLE,
      message,
      httpStatus: 410,
      retryable: false,
    });
  },
  sourceChanged(message = '原文件版本已变更'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.SOURCE_CHANGED,
      message,
      httpStatus: 409,
      retryable: false,
    });
  },
  idempotencyConflict(message = '幂等键冲突'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
      message,
      httpStatus: 409,
      retryable: false,
    });
  },
  requestInProgress(message = '同键请求处理中'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.REQUEST_IN_PROGRESS,
      message,
      httpStatus: 409,
      retryable: true,
    });
  },
  rangeNotSatisfiable(message = '请求范围不合法'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message,
      httpStatus: 416,
      retryable: false,
    });
  },
  protocolError(message: string): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message,
      httpStatus: 400,
      retryable: false,
    });
  },
  serviceUnavailable(message = '服务暂不可用'): HostPreviewError {
    return new HostPreviewError({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message,
      httpStatus: 503,
      retryable: true,
    });
  },
  unknown(cause: unknown): HostPreviewError {
    const message = cause instanceof Error ? cause.message : '未知错误';
    return new HostPreviewError({
      code: ERROR_CODES.UNKNOWN_ERROR,
      message,
      httpStatus: 500,
      retryable: false,
    });
  },
};
