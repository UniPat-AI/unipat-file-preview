import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Orchestrator, HostErrors } from '../dist/index.js';
import {
  InMemoryStore,
  InMemorySourceProvider,
  InMemoryArtifactStorage,
  EchoRunner,
} from '../dist/inmemory/index.js';

function silentLogger() {
  return { log: () => {} };
}

async function seedPreview(store, sourceProvider, namespace) {
  const bytes = new TextEncoder().encode('hello preview');
  sourceProvider.register({
    resourceKey: 'files/a.txt',
    version: 'v1',
    filename: 'a.txt',
    extension: 'txt',
    bytes,
  });
  const resolved = await sourceProvider.resolve(
    { namespace, tenantId: 't1' },
    { resourceKey: 'files/a.txt', version: 'v1' },
    new AbortController().signal,
  );
  const ensured = await store.ensurePreview({
    namespace,
    tenantId: 't1',
    file: { resourceKey: 'files/a.txt', version: 'v1' },
    profileId: 'default',
    source: resolved,
    actorUserId: 'user_test',
  });
  return ensured;
}

test('orchestrator.tick 走通 queued → published', async () => {
  const namespace = 'ns_pub';
  const store = new InMemoryStore({ namespace });
  const sourceProvider = new InMemorySourceProvider();
  const artifactStorage = new InMemoryArtifactStorage();
  const runner = new EchoRunner();
  const orchestrator = new Orchestrator({
    namespace,
    workerId: 'w1',
    store,
    sourceProvider,
    artifactStorage,
    runner,
    logger: silentLogger(),
  });

  const ensured = await seedPreview(store, sourceProvider, namespace);
  const worked = await orchestrator.tick();
  assert.equal(worked, true);

  const preview = await store.getPreview(ensured.preview.id);
  assert.equal(preview.executionState, 'succeeded');
  assert.equal(preview.publishedRevision, 1);
  const result = await store.getResult(ensured.preview.id, 1);
  assert.ok(result, '应有已发布结果');
  assert.equal(result.availability, 'ready');
  const artifacts = result.manifest.artifacts;
  assert.ok(Array.isArray(artifacts) && artifacts.length >= 1);
});

test('orchestrator 遇到 SERVICE_UNAVAILABLE 会触发重试（新 job 入队）', async () => {
  const namespace = 'ns_retry';
  const store = new InMemoryStore({
    namespace,
    baseBackoffMs: 0,
    maxBackoffMs: 0,
    maxAttempts: 5,
  });
  const sourceProvider = new InMemorySourceProvider();
  const artifactStorage = new InMemoryArtifactStorage();
  // 一直抛 SERVICE_UNAVAILABLE 的 runner
  const runner = {
    async run() {
      throw HostErrors.serviceUnavailable('runner down');
    },
    async cancel() {
      return true;
    },
    async capabilities() {
      return {
        protocolVersions: ['1.0'],
        imageDigest: 'x',
        fontDigest: 'x',
        supportedFormats: [],
      };
    },
  };
  const orchestrator = new Orchestrator({
    namespace,
    workerId: 'w1',
    store,
    sourceProvider,
    artifactStorage,
    runner,
    logger: silentLogger(),
  });

  const ensured = await seedPreview(store, sourceProvider, namespace);
  const firstJobId = ensured.createdJob.id;
  const worked = await orchestrator.tick();
  assert.equal(worked, true);

  // 首次失败后应有一个 attemptNo=2 的新 job 入队（不同 id）
  const secondClaim = await store.claimJob({
    workerId: 'w1',
    namespace,
    leaseDurationMs: 1000,
  });
  assert.ok(secondClaim, '应领取到重试 job');
  assert.notEqual(secondClaim.id, firstJobId);
  assert.equal(secondClaim.attemptNo, 2);
});

test('orchestrator.abortPreviewJobs 会传播到 runner signal', async () => {
  const namespace = 'ns_cancel';
  const store = new InMemoryStore({ namespace });
  const sourceProvider = new InMemorySourceProvider();
  const artifactStorage = new InMemoryArtifactStorage();

  let capturedSignal = null;
  const runner = {
    async run(_input, _handle, _out, _limits, signal) {
      capturedSignal = signal;
      // 等待被 abort
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () =>
          reject(new Error('aborted-by-signal')),
        );
      });
      throw new Error('should not reach');
    },
    async cancel() {
      return true;
    },
    async capabilities() {
      return {
        protocolVersions: ['1.0'],
        imageDigest: 'x',
        fontDigest: 'x',
        supportedFormats: [],
      };
    },
  };
  const orchestrator = new Orchestrator({
    namespace,
    workerId: 'w1',
    store,
    sourceProvider,
    artifactStorage,
    runner,
    logger: silentLogger(),
  });

  const ensured = await seedPreview(store, sourceProvider, namespace);
  const tickPromise = orchestrator.tick();
  // 给 tick 一点时间到达 runner.run
  await new Promise((r) => setTimeout(r, 50));
  const aborted = orchestrator.abortPreviewJobs(ensured.preview.id);
  assert.equal(aborted, 1);
  await tickPromise;

  assert.ok(capturedSignal, 'runner 应收到 signal');
  assert.equal(capturedSignal.aborted, true);

  const preview = await store.getPreview(ensured.preview.id);
  // 取消/失败任一都可以，关键是不 succeeded
  assert.notEqual(preview.executionState, 'succeeded');
});

test('orchestrator.sweepOnce 清理过期 preview 并触发 onArtifactCleanup', async () => {
  const namespace = 'ns_ttl';
  const cleaned = [];
  const store = new InMemoryStore({
    namespace,
    onArtifactCleanup: async (keys) => {
      for (const k of keys) cleaned.push(k);
    },
  });
  const sourceProvider = new InMemorySourceProvider();
  const artifactStorage = new InMemoryArtifactStorage();
  const runner = new EchoRunner();
  const orchestrator = new Orchestrator({
    namespace,
    workerId: 'w1',
    store,
    sourceProvider,
    artifactStorage,
    runner,
    logger: silentLogger(),
    ttlMs: 1,
  });

  const ensured = await seedPreview(store, sourceProvider, namespace);
  await orchestrator.tick();

  // 强制标记为已过期
  store.markPreviewExpireAt(ensured.preview.id, Date.now() - 1);

  const removed = await orchestrator.sweepOnce();
  assert.deepEqual([...removed], [ensured.preview.id]);
  const gone = await store.getPreview(ensured.preview.id);
  assert.equal(gone, null);
  assert.ok(cleaned.length >= 1, '应至少清理一个 artifact object_key');
  assert.ok(cleaned[0].includes(ensured.preview.id));
});
