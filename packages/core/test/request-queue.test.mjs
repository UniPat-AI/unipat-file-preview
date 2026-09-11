import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RequestQueue } from '../dist/index.js';

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('RequestQueue 尊重 maxParallel 上限', async () => {
  const q = new RequestQueue({ maxParallel: 2 });
  const started = [];
  const gates = [defer(), defer(), defer(), defer()];

  const tasks = gates.map((g, i) =>
    q.enqueue(async () => {
      started.push(i);
      await g.promise;
      return i;
    }),
  );

  // 让微任务队列排空
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(started, [0, 1], '初始应只启动 2 个');

  gates[0].resolve();
  await tasks[0];

  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(started, [0, 1, 2], '完成一个后应放行下一个');

  gates[1].resolve();
  gates[2].resolve();
  gates[3].resolve();

  const values = await Promise.all(tasks);
  assert.deepEqual(values, [0, 1, 2, 3]);
});

test('RequestQueue 排队期间可通过 AbortSignal 取消', async () => {
  const q = new RequestQueue({ maxParallel: 1 });
  const gate = defer();
  const first = q.enqueue(async () => {
    await gate.promise;
    return 'done';
  });

  const ac = new AbortController();
  const second = q.enqueue(async () => 'never', ac.signal);
  ac.abort();

  await assert.rejects(second, (err) => err.name === 'AbortError');

  gate.resolve();
  assert.equal(await first, 'done');
});

test('RequestQueue 传入已经 abort 的 signal 立刻 reject', async () => {
  const q = new RequestQueue({ maxParallel: 2 });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    q.enqueue(async () => 'x', ac.signal),
    (err) => err.name === 'AbortError',
  );
});

test('RequestQueue 默认 maxParallel = 4', async () => {
  const q = new RequestQueue();
  const started = [];
  const gates = Array.from({ length: 6 }, () => defer());
  const tasks = gates.map((g, i) =>
    q.enqueue(async () => {
      started.push(i);
      await g.promise;
      return i;
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates.forEach((g) => g.resolve());
  await Promise.all(tasks);
});

test('RequestQueue 拒绝非法 maxParallel', () => {
  assert.throws(() => new RequestQueue({ maxParallel: 0 }));
  assert.throws(() => new RequestQueue({ maxParallel: -1 }));
  assert.throws(() => new RequestQueue({ maxParallel: 1.5 }));
});

test('RequestQueue 高优先级任务插队；同优先级保持 FIFO', async () => {
  const q = new RequestQueue({ maxParallel: 1 });
  const executionOrder = [];
  const gate = defer();

  // 占位任务把并发填满
  const holder = q.enqueue(async () => {
    await gate.promise;
    executionOrder.push('holder');
    return 'holder';
  });

  // 三个后续任务：A p=0, B p=10, C p=0
  const a = q.enqueue(
    async () => {
      executionOrder.push('A');
    },
    { priority: 0 },
  );
  const b = q.enqueue(
    async () => {
      executionOrder.push('B');
    },
    { priority: 10 },
  );
  const c = q.enqueue(
    async () => {
      executionOrder.push('C');
    },
    { priority: 0 },
  );

  gate.resolve();
  await Promise.all([holder, a, b, c]);
  // holder 是先启动的，随后按 [B, A, C] 优先级/FIFO 出队
  assert.deepEqual(executionOrder, ['holder', 'B', 'A', 'C']);
});

test('RequestQueue perKeyMaxParallel 限制单 key 并发', async () => {
  const q = new RequestQueue({ maxParallel: 5, perKeyMaxParallel: 2 });
  let inflightA = 0;
  let maxInflightA = 0;
  const gates = [defer(), defer(), defer(), defer()];

  const tasks = gates.map((g, i) =>
    q.enqueue(
      async () => {
        inflightA += 1;
        maxInflightA = Math.max(maxInflightA, inflightA);
        await g.promise;
        inflightA -= 1;
        return i;
      },
      { key: 'A' },
    ),
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(maxInflightA, 2, '同一 key 并发上限 = 2');

  gates.forEach((g) => g.resolve());
  await Promise.all(tasks);
  assert.equal(maxInflightA, 2);
});

test('RequestQueue perKeyMaxParallel 不影响不同 key 与无 key 任务', async () => {
  const q = new RequestQueue({ maxParallel: 4, perKeyMaxParallel: 1 });
  const running = new Set();
  let maxConcurrent = 0;
  const gates = Array.from({ length: 4 }, () => defer());

  const tasks = [
    q.enqueue(
      async () => {
        running.add('A1');
        maxConcurrent = Math.max(maxConcurrent, running.size);
        await gates[0].promise;
        running.delete('A1');
      },
      { key: 'A' },
    ),
    q.enqueue(
      async () => {
        running.add('B1');
        maxConcurrent = Math.max(maxConcurrent, running.size);
        await gates[1].promise;
        running.delete('B1');
      },
      { key: 'B' },
    ),
    q.enqueue(async () => {
      running.add('noKey');
      maxConcurrent = Math.max(maxConcurrent, running.size);
      await gates[2].promise;
      running.delete('noKey');
    }),
    q.enqueue(
      async () => {
        running.add('A2');
        maxConcurrent = Math.max(maxConcurrent, running.size);
        await gates[3].promise;
        running.delete('A2');
      },
      { key: 'A' },
    ),
  ];

  await Promise.resolve();
  await Promise.resolve();
  // A2 因 perKey=1 被卡住，其它 3 个应当同时在跑
  assert.equal(maxConcurrent, 3);
  gates.forEach((g) => g.resolve());
  await Promise.all(tasks);
});

test('RequestQueue 兼容旧签名 enqueue(fn, signal)', async () => {
  const q = new RequestQueue({ maxParallel: 1 });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    q.enqueue(async () => 'x', ac.signal),
    (err) => err.name === 'AbortError',
  );
});
