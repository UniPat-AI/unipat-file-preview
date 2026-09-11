import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResultCacheKey,
  buildSheetWindowCacheKey,
  buildStateCacheKey,
} from '../dist/index.js';

test('buildResultCacheKey 稳定拼接', () => {
  const key = buildResultCacheKey({
    file: { resourceKey: 'files/a.txt', version: 'v1' },
    profileId: 'default',
    publishedRevision: 3,
    resourceHint: 'manifest',
  });
  assert.equal(key, 'result|files/a.txt|v1|default|3|manifest');
});

test('buildResultCacheKey 对不同 revision 产出不同 key', () => {
  const base = {
    file: { resourceKey: 'files/a.txt', version: 'v1' },
    profileId: 'default',
    resourceHint: 'manifest',
  };
  const a = buildResultCacheKey({ ...base, publishedRevision: 1 });
  const b = buildResultCacheKey({ ...base, publishedRevision: 2 });
  assert.notEqual(a, b);
});

test('buildSheetWindowCacheKey 完整覆盖窗口维度', () => {
  const key = buildSheetWindowCacheKey({
    previewId: 'p1',
    publishedRevision: 4,
    sheetId: 's0',
    rowStart: 0,
    rowEnd: 50,
    colStart: 0,
    colEnd: 20,
  });
  assert.equal(key, 'sheet-window|p1|4|s0|0|50|0|20');
});

test('buildStateCacheKey 覆盖 generation + revision', () => {
  const key = buildStateCacheKey({
    previewId: 'p1',
    generation: 7,
    revision: 4,
  });
  assert.equal(key, 'state|p1|7|4');
});
