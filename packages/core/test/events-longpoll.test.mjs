import { test } from 'node:test';
import assert from 'node:assert/strict';

import { subscribePreviewEventsLongPoll } from '../dist/index.js';

function nextTick() {
  return new Promise((r) => setImmediate(r));
}

function makeState(overrides = {}) {
  return {
    preview_id: 'p1',
    file_ref: { resource_key: 'k', version: 'v' },
    profile_id: 'default',
    generation: 1,
    execution_state: 'queued',
    availability: 'none',
    stage: 'queued',
    progress: null,
    revision: 0,
    published_revision: null,
    is_previous_result: false,
    permissions: {
      download_original: false,
      print: false,
      copy: false,
      retry: false,
    },
    warnings: [],
    error: null,
    retry_after_ms: null,
    ...overrides,
  };
}

test('longpoll: 只有状态变化才 dispatch，稳态后放慢间隔', async () => {
  const responses = [
    makeState({ execution_state: 'queued', revision: 0 }),
    makeState({ execution_state: 'queued', revision: 0 }), // 未变化
    makeState({ execution_state: 'running', revision: 0 }),
    makeState({
      execution_state: 'succeeded',
      availability: 'ready',
      revision: 1,
      published_revision: 1,
    }),
  ];
  let idx = 0;
  const urls = [];
  const events = [];
  let opened = 0;

  const fakeFetch = async (url) => {
    urls.push(String(url));
    const body = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    };
  };

  const sub = subscribePreviewEventsLongPoll({
    baseUrl: 'http://x',
    previewId: 'p1',
    fetch: fakeFetch,
    activeIntervalMs: 1,
    idleIntervalMs: 50,
    onOpen: () => {
      opened += 1;
    },
    onEvent: (evt) => events.push(evt),
  });

  // 消耗到看见 succeeded
  for (let i = 0; i < 200 && events.length < 3; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 2));
  }
  sub.close();

  assert.equal(opened, 1);
  // 期望 3 次 dispatch：queued(初始) → running → succeeded
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'preview-state');
  assert.equal(events[0].state.executionState, 'queued');
  assert.equal(events[1].state.executionState, 'running');
  assert.equal(events[2].state.executionState, 'succeeded');
  assert.ok(urls[0].includes('preview_id=p1'));
});

test('longpoll: URL 使用 fileRef 时携带 resource_key/version', async () => {
  let captured;
  const fakeFetch = async (url) => {
    captured = String(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () =>
        makeState({
          execution_state: 'succeeded',
          availability: 'ready',
          revision: 1,
          published_revision: 1,
        }),
    };
  };
  const sub = subscribePreviewEventsLongPoll({
    baseUrl: 'http://x',
    previewId: 'p1',
    fileRef: { resourceKey: 'K', version: 'V' },
    profileId: 'custom',
    fetch: fakeFetch,
    onEvent: () => {},
  });
  for (let i = 0; i < 5; i++) await nextTick();
  sub.close();
  const u = new URL(captured);
  assert.equal(u.searchParams.get('resource_key'), 'K');
  assert.equal(u.searchParams.get('version'), 'V');
  assert.equal(u.searchParams.get('profile_id'), 'custom');
  assert.equal(u.searchParams.get('preview_id'), null);
});

test('longpoll: close() 之后不再触发 fetch', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => makeState(),
    };
  };
  const sub = subscribePreviewEventsLongPoll({
    baseUrl: 'http://x',
    previewId: 'p1',
    activeIntervalMs: 1,
    fetch: fakeFetch,
    onEvent: () => {},
  });
  await nextTick();
  await new Promise((r) => setTimeout(r, 3));
  sub.close();
  const snapshot = calls;
  await new Promise((r) => setTimeout(r, 20));
  // close 后可能残留一次已发起但未 resolve 的请求，但总量不能持续增长
  assert.ok(calls <= snapshot + 1);
});
