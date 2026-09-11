// 最小端到端：内存桩 + node http 服务 + core 客户端。
// 流程：
//   1) 组装 host（5 个内存桩 + orchestrator + host）
//   2) 起 http server 挂 handler
//   3) core 客户端：requestGenerate → 轮询 getState 直到 availability=ready
//   4) fetchManifest → fetchArtifact 校验内容

import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import {
  allowAllAuthorize,
  InMemorySourceProvider,
  InMemoryArtifactStorage,
  InMemoryIdempotencyStore,
  InMemoryStore,
  EchoRunner,
} from '@unipat/file-preview-node/inmemory';

import {
  createPreviewHost,
  createHttpHandler,
  Orchestrator,
} from '@unipat/file-preview-node';

import { createHttpPreviewClient } from '@unipat/file-preview-core';

const NAMESPACE = 'demo';
const TENANT = 'tenant-1';
const USER = 'user-1';

const logger = {
  log(level, event, fields) {
    // 仅打印 warn / error / 关键信息
    if (level === 'debug') return;
    console.log(`[${level}] ${event}`, fields ?? {});
  },
};

// --- 1) 组装 host ---
const sourceProvider = new InMemorySourceProvider();
const bytes = new TextEncoder().encode(
  '这是一段用于 e2e 的示例文本，包含中文与 English。',
);
sourceProvider.register({
  resourceKey: 'files/hello.txt',
  version: 'v1',
  filename: 'hello.txt',
  extension: 'txt',
  bytes,
});

const store = new InMemoryStore({ namespace: NAMESPACE });
const artifactStorage = new InMemoryArtifactStorage();
const runner = new EchoRunner();
const idempotencyStore = new InMemoryIdempotencyStore();

const orchestrator = new Orchestrator({
  namespace: NAMESPACE,
  workerId: `worker-${randomUUID().slice(0, 8)}`,
  store,
  sourceProvider,
  artifactStorage,
  runner,
  logger,
  pollIntervalMs: 50,
});

const host = createPreviewHost({
  namespace: NAMESPACE,
  authorize: allowAllAuthorize,
  sourceProvider,
  artifactStorage,
  store,
  idempotencyStore,
  orchestrator,
  logger,
});

// --- 2) 起 http server ---
const handler = createHttpHandler({
  host,
  namespace: NAMESPACE,
  logger,
  resolvePrincipal: async () => ({
    userId: USER,
    tenantId: TENANT,
    roles: ['viewer'],
  }),
});

const server = createServer(handler);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`[info] host listening at ${baseUrl}`);

orchestrator.start();

// --- 3) core 客户端调用 ---
const client = createHttpPreviewClient({ baseUrl });

const idempotencyKey = randomUUID();
const file = { resourceKey: 'files/hello.txt', version: 'v1' };

let state = await client.requestGenerate({
  file,
  profileId: 'default',
  idempotencyKey,
});
console.log('[info] initial state:', {
  previewId: state.previewId,
  availability: state.availability,
  executionState: state.executionState,
});

// 轮询直到 ready
const deadline = Date.now() + 10_000;
while (state.availability !== 'ready' && Date.now() < deadline) {
  await delay(100);
  state = await client.getState({ file, profileId: 'default' });
}

if (state.availability !== 'ready') {
  console.error('[error] preview not ready within timeout, last state:', state);
  await shutdown(1);
}

console.log('[info] preview ready:', {
  previewId: state.previewId,
  publishedRevision: state.publishedRevision,
});

// --- 4) fetch manifest + artifact ---
const manifest = await client.fetchManifest({
  previewId: state.previewId,
  publishedRevision: state.publishedRevision,
});
console.log(
  '[info] manifest artifacts:',
  manifest.artifacts.map((a) => ({
    id: a.artifactId,
    mediaType: a.mediaType,
    sizeBytes: a.sizeBytes,
  })),
);

const artifact = manifest.artifacts[0];
const buf = await client.fetchArtifact({
  previewId: state.previewId,
  publishedRevision: state.publishedRevision,
  artifactId: artifact.artifactId,
});
const text = new TextDecoder().decode(new Uint8Array(buf));
console.log('[info] artifact content:', text);

const roundtripOk =
  text.length > 0 && text.includes('sha256=') && buf.byteLength > 0;
console.log('[info] roundtrip ok:', roundtripOk);

await shutdown(roundtripOk ? 0 : 1);

async function shutdown(code) {
  try {
    await orchestrator.stop();
  } catch {}
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(code);
}
