import { test } from 'node:test';
import assert from 'node:assert/strict';

import { subscribePreviewEvents } from '../dist/index.js';

function makeReadable(chunks) {
  const encoder = new TextEncoder();
  const it = chunks[Symbol.iterator]();
  return new ReadableStream({
    pull(controller) {
      const { value, done } = it.next();
      if (done) {
        controller.close();
        return;
      }
      if (value === '__END__') {
        controller.close();
        return;
      }
      controller.enqueue(
        typeof value === 'string' ? encoder.encode(value) : value,
      );
    },
  });
}

function nextTick() {
  return new Promise((r) => setTimeout(r, 0));
}

test('SSE 分包解析 + id 累积 + multiline data', async () => {
  const events = [];
  const opened = { count: 0 };

  const bodyChunks = [
    'id: 1\nevent: preview-state\ndata: {"event_id":1,"preview_id":"p1","type":"preview-state",',
    '"state":{"preview_id":"p1","file_ref":{"resource_key":"k","version":"v"},"profile_id":"default","generation":1,"execution_state":"queued","availability":"none","stage":"queued","progress":null,"revision":0,"published_revision":null,"is_previous_result":false,"permissions":{"download_original":false,"print":false,"copy":false,"retry":false},"warnings":[],"error":null,"retry_after_ms":null},',
    '"emitted_at":"2026-09-10T00:00:00Z"}\n\n',
    'id: 2\nevent: preview-state\ndata: {"event_id":2,"preview_id":"p1","type":"preview-state","state":null,"emitted_at":"2026-09-10T00:00:01Z"}\n\n',
    ': keep-alive\n\n',
  ];

  let lastRequestHeaders;
  const fakeFetch = async (_url, init) => {
    lastRequestHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      body: makeReadable(bodyChunks),
    };
  };

  const sub = subscribePreviewEvents({
    baseUrl: 'http://x',
    previewId: 'p1',
    fetch: fakeFetch,
    autoReconnect: false,
    onOpen: () => {
      opened.count += 1;
    },
    onEvent: (evt) => events.push(evt),
  });

  // 等 stream 消耗完
  for (let i = 0; i < 20 && events.length < 2; i++) await nextTick();

  assert.equal(opened.count, 1);
  assert.equal(events.length, 2);
  assert.equal(events[0].eventId, 1);
  assert.equal(events[0].type, 'preview-state');
  assert.ok(events[0].state);
  assert.equal(events[0].state.previewId, 'p1');
  assert.equal(events[0].state.executionState, 'queued');
  assert.equal(events[1].eventId, 2);
  assert.equal(events[1].state, null);

  // 首次连接不应带 Last-Event-ID
  assert.equal(lastRequestHeaders['last-event-id'], undefined);

  sub.close();
});

test('第二次连接会带上 Last-Event-ID', async () => {
  let call = 0;
  const captured = [];
  const fakeFetch = async (_url, init) => {
    call += 1;
    captured.push(init.headers['last-event-id']);
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        body: makeReadable([
          'id: 7\nevent: preview-state\ndata: {"event_id":7,"preview_id":"p1","type":"preview-state","state":null,"emitted_at":"2026-09-10T00:00:00Z"}\n\n',
          '__END__',
        ]),
      };
    }
    // 第二次连接立刻结束
    return {
      ok: true,
      status: 200,
      body: makeReadable(['__END__']),
    };
  };

  const events = [];
  const sub = subscribePreviewEvents({
    baseUrl: 'http://x',
    previewId: 'p1',
    fetch: fakeFetch,
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
    onEvent: (evt) => events.push(evt),
  });

  for (let i = 0; i < 100 && call < 2; i++) await new Promise((r) => setTimeout(r, 5));

  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 7);
  assert.equal(captured[0], undefined);
  assert.equal(captured[1], '7');

  sub.close();
});

test('close() 会中止连接且不再触发事件', async () => {
  let aborted = false;
  const fakeFetch = async (_url, init) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
    });
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        // 永不结束
        pull() {},
      }),
    };
  };
  const sub = subscribePreviewEvents({
    baseUrl: 'http://x',
    previewId: 'p1',
    fetch: fakeFetch,
    onEvent: () => {},
  });
  await nextTick();
  sub.close();
  await nextTick();
  assert.equal(aborted, true);
});

test('非 2xx 响应触发 onError 并按退避重连', async () => {
  const errors = [];
  let call = 0;
  const fakeFetch = async () => {
    call += 1;
    if (call === 1) {
      return { ok: false, status: 503, body: null };
    }
    return {
      ok: true,
      status: 200,
      body: makeReadable(['__END__']),
    };
  };
  const sub = subscribePreviewEvents({
    baseUrl: 'http://x',
    previewId: 'p1',
    fetch: fakeFetch,
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
    onEvent: () => {},
    onError: (e) => errors.push(e),
  });

  for (let i = 0; i < 100 && call < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(errors.length >= 1);
  assert.match(String(errors[0]?.message ?? errors[0]), /SSE 建立失败/);
  sub.close();
});
