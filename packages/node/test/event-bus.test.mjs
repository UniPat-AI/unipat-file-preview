import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewEventBus } from '../dist/event-bus.js';

const dummyState = (rev) => ({
  previewId: 'p1',
  fileRef: { resourceKey: 'k', version: 'v' },
  profileId: 'default',
  generation: 1,
  executionState: 'succeeded',
  availability: 'ready',
  stage: 'queued',
  progress: null,
  revision: rev,
  publishedRevision: rev,
  isPreviousResult: false,
  permissions: {
    downloadOriginal: false,
    print: false,
    copy: false,
    retry: false,
  },
  warnings: [],
  error: null,
  retryAfterMs: null,
});

test('publishState 会递增 eventId 并触发所有订阅者', () => {
  const bus = new PreviewEventBus();
  const seen = [];
  const sub = bus.subscribe('p1', (evt) => seen.push(evt.eventId));

  const e1 = bus.publishState('p1', dummyState(1));
  const e2 = bus.publishState('p1', dummyState(2));

  assert.equal(e1.eventId, 1);
  assert.equal(e2.eventId, 2);
  assert.deepEqual(seen, [1, 2]);
  sub.close();
});

test('close 之后订阅者不再收到事件', () => {
  const bus = new PreviewEventBus();
  const seen = [];
  const sub = bus.subscribe('p1', (evt) => seen.push(evt.eventId));
  bus.publishState('p1', dummyState(1));
  sub.close();
  bus.publishState('p1', dummyState(2));
  assert.deepEqual(seen, [1]);
});

test('since(lastEventId) 只返回严格大于该 id 的历史事件', () => {
  const bus = new PreviewEventBus();
  bus.publishState('p1', dummyState(1));
  bus.publishState('p1', dummyState(2));
  bus.publishState('p1', dummyState(3));

  const missed = bus.since('p1', 1);
  assert.equal(missed.length, 2);
  assert.equal(missed[0].eventId, 2);
  assert.equal(missed[1].eventId, 3);

  assert.equal(bus.since('p1', 99).length, 0);
  assert.equal(bus.since('unknown', 0).length, 0);
});

test('环形缓冲会淘汰最旧事件（ringSize=3）', () => {
  const bus = new PreviewEventBus({ ringSize: 3 });
  for (let i = 0; i < 5; i++) {
    bus.publishState('p1', dummyState(i + 1));
  }
  const all = bus.since('p1', 0);
  // 只保留最近 3 条（eventId=3,4,5）
  assert.deepEqual(
    all.map((e) => e.eventId),
    [3, 4, 5],
  );
});
