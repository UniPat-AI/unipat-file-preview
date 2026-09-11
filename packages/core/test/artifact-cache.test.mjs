import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createArtifactCache,
  isFresh,
  parseMaxAgeMs,
} from '../dist/index.js';

function buf(n) {
  return new Uint8Array(n).buffer;
}

test('parseMaxAgeMs 识别 max-age', () => {
  assert.equal(parseMaxAgeMs(undefined), undefined);
  assert.equal(parseMaxAgeMs('no-cache'), undefined);
  assert.equal(parseMaxAgeMs('public, max-age=60'), 60_000);
  assert.equal(parseMaxAgeMs('max-age=1, immutable'), 1_000);
});

test('isFresh: 无 max-age 时视为陈旧', () => {
  assert.equal(
    isFresh({
      data: buf(1),
      storedAt: 100,
    }, 200),
    false,
  );
  assert.equal(
    isFresh({
      data: buf(1),
      storedAt: 100,
      maxAgeMs: 500,
    }, 500),
    true,
  );
  assert.equal(
    isFresh({
      data: buf(1),
      storedAt: 100,
      maxAgeMs: 500,
    }, 800),
    false,
  );
});

test('createArtifactCache: 基本 CRUD + byteSize', () => {
  const c = createArtifactCache({ maxEntries: 4, maxBytes: 1024 });
  c.set('a', { data: buf(100), storedAt: 0 });
  c.set('b', { data: buf(200), storedAt: 0 });
  assert.equal(c.size, 2);
  assert.equal(c.byteSize, 300);
  assert.ok(c.get('a'));
  c.delete('a');
  assert.equal(c.size, 1);
  assert.equal(c.byteSize, 200);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.byteSize, 0);
});

test('createArtifactCache: 超过 maxEntries 按 LRU 驱逐', () => {
  const c = createArtifactCache({ maxEntries: 2, maxBytes: 10_000 });
  c.set('a', { data: buf(1), storedAt: 0 });
  c.set('b', { data: buf(1), storedAt: 0 });
  // touch a → a 成为最近使用
  c.get('a');
  c.set('c', { data: buf(1), storedAt: 0 });
  // 应当驱逐 b
  assert.equal(c.get('a')?.data.byteLength, 1);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('c')?.data.byteLength, 1);
});

test('createArtifactCache: 超过 maxBytes 按 FIFO 驱逐', () => {
  const c = createArtifactCache({ maxEntries: 100, maxBytes: 300 });
  c.set('a', { data: buf(100), storedAt: 0 });
  c.set('b', { data: buf(100), storedAt: 0 });
  c.set('c', { data: buf(100), storedAt: 0 });
  c.set('d', { data: buf(100), storedAt: 0 });
  // 400 > 300 → 至少驱逐一条
  assert.ok(c.byteSize <= 300);
  assert.equal(c.get('a'), undefined);
});

test('createArtifactCache: 非法参数抛错', () => {
  assert.throws(() => createArtifactCache({ maxEntries: 0 }));
  assert.throws(() => createArtifactCache({ maxBytes: 0 }));
});
