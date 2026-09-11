import type { PreviewErrorPayload } from '@unipat/file-preview-contracts';
import { deepCamelToSnake } from './case-mapping.js';

export interface SuccessEnvelope<T> {
  request_id: string;
  data: T;
}

export interface ErrorEnvelope {
  request_id: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
  };
}

export function encodeSuccess<T>(requestId: string, data: T): SuccessEnvelope<unknown> {
  return {
    request_id: requestId,
    data: deepCamelToSnake(data),
  };
}

export function encodeError(
  requestId: string,
  error: PreviewErrorPayload,
): ErrorEnvelope {
  return {
    request_id: requestId,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}
