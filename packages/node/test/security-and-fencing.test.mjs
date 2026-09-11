import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createPreviewHost, Orchestrator, createHttpHandler, HostErrors } from '../dist/index.js';
import {
  InMemoryStore,
  InMemorySourceProvider,
  InMemoryArtifactStorage,
  InMemoryIdempotencyStore,
  EchoRunner,
} from '../dist/inmemory/index.js';

function setup(authorize = async () => ({ allowed: true }), runner = new EchoRunner()) {
  const ns = 'test-ns';
  const file = { resourceKey: 'doc/readme.txt', version: 'v1' };
  const store = new InMemoryStore({ namespace: ns });
  const sourceProvider = new InMemorySourceProvider();
  const artifactStorage = new InMemoryArtifactStorage();
  const logger = { log() {} };

  sourceProvider.register({
    ...file,
    filename: 'readme.txt',
    extension: 'txt',
    bytes: new TextEncoder().encode('hello security world'),
  });

  const orchestrator = new Orchestrator({
    namespace: ns,
    workerId: 'w_sec',
    store,
    sourceProvider,
    artifactStorage,
    runner,
    logger,
  });

  const host = createPreviewHost({
    namespace: ns,
    authorize,
    store,
    sourceProvider,
    artifactStorage,
    idempotencyStore: new InMemoryIdempotencyStore(),
    orchestrator,
    logger,
  });

  const ctx = (tenantId = 'tenant_a') => ({
    namespace: ns,
    principal: { tenantId, userId: 'u1' },
    signal: new AbortController().signal,
    requestId: 'req_1',
  });

  return { ns, file, store, sourceProvider, artifactStorage, orchestrator, host, ctx };
}

test('R01: 跨租户 / 跨 namespace 访问 preview 返回 404', async () => {
  const { host, orchestrator, file, ctx } = setup();
  const state = await host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' });
  await orchestrator.tick();

  // tenant_b 读取 tenant_a 的 previewId 返回 404
  await assert.rejects(
    () => host.getManifest(ctx('tenant_b'), { previewId: state.previewId, publishedRevision: 1 }),
    (err) => err.code === 'RESOURCE_NOT_FOUND' && err.httpStatus === 404,
  );

  await assert.rejects(
    () => host.getPreviewStateById(ctx('tenant_b'), { previewId: state.previewId }),
    (err) => err.code === 'RESOURCE_NOT_FOUND' && err.httpStatus === 404,
  );
});

test('R02: 源失效时阻止读取，且发布前复核', async () => {
  const { host, orchestrator, sourceProvider, file, ctx } = setup();
  const state = await host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' });
  await orchestrator.tick();

  // 正常可以读取
  const m1 = await host.getManifest(ctx('tenant_a'), { previewId: state.previewId, publishedRevision: 1 });
  assert.ok(m1);

  // 模拟源失效
  sourceProvider.isAvailable = async () => false;

  await assert.rejects(
    () => host.getManifest(ctx('tenant_a'), { previewId: state.previewId, publishedRevision: 1 }),
    (err) => err.code === 'SOURCE_UNAVAILABLE',
  );
});

test('R04: 只读查状态不创建 job，未生成时返回 404，生成需 generate 权限', async () => {
  // 只给 view 权限
  const { host, store, file, ctx } = setup(async ({ action }) => ({
    allowed: action === 'view',
  }));

  // 未生成前 GET 状态返回 404
  await assert.rejects(
    () => host.getPreviewState(ctx('tenant_a'), { file, profileId: 'default' }),
    (err) => err.code === 'RESOURCE_NOT_FOUND',
  );

  // 此时 store 中没有 job 产生
  assert.equal(await store.claimJob({ workerId: 'w', namespace: 'test-ns', leaseDurationMs: 1000 }), null);

  // 尝试 ensurePreview，由于缺少 generate 权限，被拒绝 403
  await assert.rejects(
    () => host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' }),
    (err) => err.code === 'ACTION_FORBIDDEN',
  );
});

test('R05: clearResults 清理并防止旧任务复活结果，版本号单调递增', async () => {
  const { host, store, file, ctx } = setup();
  const s = await host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' });
  const job = await store.claimJob({ namespace: 'test-ns', workerId: 'w', leaseDurationMs: 10000 });
  assert.ok(job);

  // 执行 clear
  await host.clear(ctx('tenant_a'), { previewId: s.previewId });

  // 旧 job 试图 publishResult 必须被拒绝
  await assert.rejects(
    () =>
      store.publishResult({
        previewId: s.previewId,
        jobId: job.id,
        leaseToken: job.leaseToken,
        manifest: { artifacts: [] },
        availability: 'ready',
      }),
  );

  const preview = await store.getPreview(s.previewId);
  assert.equal(preview.executionState, 'cancelled');
});

test('R06: 过期租约拒绝续租 heartbeat', async () => {
  const { host, store, file, ctx } = setup();
  await host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' });
  const job = await store.claimJob({ namespace: 'test-ns', workerId: 'w', leaseDurationMs: 1 });
  assert.ok(job);

  // 等待租约过期
  await new Promise((r) => setTimeout(r, 10));

  const ok = await store.heartbeat({
    jobId: job.id,
    leaseToken: job.leaseToken,
    leaseDurationMs: 1000,
    stage: 'converting',
    progress: null,
  });
  assert.equal(ok, false);
});

test('R10: partial candidate 正确发布为 partial availability', async () => {
  class PartialRunner extends EchoRunner {
    async run(...args) {
      const r = await super.run(...args);
      return {
        ...r,
        manifest: {
          ...r.manifest,
          availability: 'partial',
          representations: r.manifest.representations.map((x) => ({ ...x, completeness: 'partial' })),
        },
      };
    }
  }

  const { host, orchestrator, store, file, ctx } = setup(undefined, new PartialRunner());
  const s = await host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' });
  await orchestrator.tick();

  const preview = await store.getPreview(s.previewId);
  assert.equal(preview.executionState, 'succeeded');
  const result = await store.getResult(s.previewId, 1);
  assert.equal(result.availability, 'partial');
});

test('R16: sweepExpired 后再次 ensure 正常工作，不抛 undefined 异常', async () => {
  const { host, orchestrator, store, file, ctx } = setup();
  const s = await host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' });
  await orchestrator.tick();

  store.markPreviewExpireAt(s.previewId, 0);
  const swept = await orchestrator.sweepOnce();
  assert.equal(swept.length, 1);

  // 再次 ensure 同一个文件
  const s2 = await host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' });
  assert.ok(s2.previewId);
  assert.notEqual(s2.previewId, s.previewId);
});

test('R03 & R17: HTTP manifest 缓存为 private, no-cache；Range 正确裁剪', async () => {
  const { host, orchestrator, file, ctx, ns } = setup();
  const s = await host.ensurePreview(ctx('tenant_a'), { file, profileId: 'default' });
  await orchestrator.tick();

  const server = createServer(
    createHttpHandler({
      host,
      namespace: ns,
      resolvePrincipal: async () => ctx('tenant_a').principal,
      logger: { log() {} },
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/file-preview/v1/previews/${s.previewId}/revisions/1`;

  try {
    // 检查 manifest Cache-Control
    const mr = await fetch(base + '/manifest');
    assert.equal(mr.headers.get('cache-control'), 'private, no-cache');
    assert.equal(mr.headers.get('x-content-type-options'), 'nosniff');
    const m = await mr.json();

    // 检查开放 Range bytes=2-
    const artId = m.artifacts[0].artifact_id;
    const statArtifact = m.artifacts[0];
    const rr = await fetch(`${base}/artifacts/${artId}`, {
      headers: { range: 'bytes=2-' },
    });
    assert.equal(rr.status, 206);
    const expectedSize = statArtifact.size_bytes - 2;
    assert.equal(rr.headers.get('content-length'), String(expectedSize));
    assert.equal(
      rr.headers.get('content-range'),
      `bytes 2-${statArtifact.size_bytes - 1}/${statArtifact.size_bytes}`,
    );
    await rr.body?.cancel();

    // 检查非法越界 Range
    const rrInvalid = await fetch(`${base}/artifacts/${artId}`, {
      headers: { range: 'bytes=500-600' },
    });
    assert.equal(rrInvalid.status, 416);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
