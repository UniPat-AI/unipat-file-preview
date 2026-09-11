import type { Principal } from '@unipat/file-preview-contracts';

export type { Principal };

export interface RequestContext {
  readonly requestId: string;
  readonly namespace: string;
  readonly principal: Principal;
  readonly signal: AbortSignal;
  /**
   * 项目请求层可选注入的幂等键。
   * 服务端不做自解释，直接透传给 IdempotencyStore.reserve。
   */
  readonly idempotencyKey?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>): void;
}
