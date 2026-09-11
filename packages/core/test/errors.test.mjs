import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PreviewError,
  isPreviewError,
  normalizePreviewError,
  ERROR_CODES,
} from '../dist/index.js';

test('normalizePreviewError 透传 PreviewError 实例', () => {
  const err = new PreviewError({
    code: ERROR_CODES.NETWORK_ERROR,
    message: 'boom',
    retryable: true,
  });
  const out = normalizePreviewError(err);
  assert.equal(out, err);
  assert.ok(isPreviewError(out));
});

test('normalizePreviewError 识别 AbortError name', () => {
  const raw = new Error('canceled');
  raw.name = 'AbortError';
  const out = normalizePreviewError(raw);
  assert.equal(out.code, ERROR_CODES.REQUEST_ABORTED);
  assert.equal(out.retryable, false);
});

test('normalizePreviewError 识别 ABORT_ERR code', () => {
  const raw = { name: 'Error', code: 'ABORT_ERR' };
  const out = normalizePreviewError(raw);
  assert.equal(out.code, ERROR_CODES.REQUEST_ABORTED);
});

test('normalizePreviewError 解析服务端 {error:{...}} 信封', () => {
  const raw = {
    error: {
      code: ERROR_CODES.SOURCE_UNAVAILABLE,
      message: '源不存在',
      retryable: false,
      details: { hint: 'x' },
    },
  };
  const out = normalizePreviewError(raw, { requestId: 'req-1' });
  assert.equal(out.code, ERROR_CODES.SOURCE_UNAVAILABLE);
  assert.equal(out.message, '源不存在');
  assert.equal(out.retryable, false);
  assert.equal(out.requestId, 'req-1');
  assert.deepEqual(out.details, { hint: 'x' });
});

test('normalizePreviewError 解析顶层 {code,message,retryable} 信封', () => {
  const raw = {
    code: ERROR_CODES.SERVICE_UNAVAILABLE,
    message: 'busy',
  };
  const out = normalizePreviewError(raw);
  assert.equal(out.code, ERROR_CODES.SERVICE_UNAVAILABLE);
  assert.equal(out.retryable, true, 'SERVICE_UNAVAILABLE 默认可重试');
});

test('normalizePreviewError 未知 code 回落到 UNKNOWN_ERROR', () => {
  const out = normalizePreviewError({ code: 'X_NOT_A_REAL_CODE' });
  assert.equal(out.code, ERROR_CODES.UNKNOWN_ERROR);
  assert.equal(out.retryable, false);
  assert.equal(typeof out.message, 'string');
});

test('normalizePreviewError 字符串异常兜底为 UNKNOWN_ERROR + 用作 message', () => {
  const out = normalizePreviewError('炸了');
  assert.equal(out.code, ERROR_CODES.UNKNOWN_ERROR);
  assert.equal(out.message, '炸了');
});

test('normalizePreviewError 空对象也能兜底', () => {
  const out = normalizePreviewError({});
  assert.equal(out.code, ERROR_CODES.UNKNOWN_ERROR);
  assert.ok(out.message.length > 0);
});
