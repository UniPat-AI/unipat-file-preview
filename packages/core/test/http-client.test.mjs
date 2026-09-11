import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpPreviewClient,
  createArtifactCache,
  ERROR_CODES,
  isPreviewError,
  HTTP_PROTOCOL_VERSION,
  IDEMPOTENCY_KEY_HEADER,
  DEFAULT_HTTP_BASE_PATH,
  DEFAULT_PROFILE_ID,
} from '../dist/index.js';

const READY_STATE = {
  preview_id: 'p1',
  file_ref: { resource_key: 'k', version: 'v' },
  profile_id: 'default',
  generation: 1,
  execution_state: 'succeeded',
  availability: 'ready',
  stage: 'queued',
  progress: null,
  revision: 3,
  published_revision: 3,
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
};

function jsonResponse(payload, extra = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name) => extra.headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => payload,
    arrayBuffer: async () => new Uint8Array().buffer,
  };
}

function errorResponse(status, payload) {
  return {
    ok: false,
    status,
    statusText: 'ERR',
    headers: { get: (name) => (name === 'x-request-id' ? 'req-xyz' : null) },
    json: async () => payload,
    arrayBuffer: async () => new Uint8Array().buffer,
  };
}

test('getState 拼接 URL、query 参数、协议头', async () => {
  let captured;
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com/',
    fetch: async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse(READY_STATE);
    },
  });

  const state = await client.getState({
    file: { resourceKey: 'K', version: 'V' },
    profileId: 'p',
  });

  assert.equal(state.previewId, 'p1');
  const u = new URL(captured.url);
  assert.equal(u.pathname, `${DEFAULT_HTTP_BASE_PATH}/state`);
  assert.equal(u.searchParams.get('resource_key'), 'K');
  assert.equal(u.searchParams.get('version'), 'V');
  assert.equal(u.searchParams.get('profile_id'), 'p');
  assert.equal(captured.init.method, 'GET');
  assert.equal(
    captured.init.headers['x-preview-protocol'],
    HTTP_PROTOCOL_VERSION,
  );
});

test('getState 未传 profileId 时使用 DEFAULT_PROFILE_ID', async () => {
  let captured;
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    fetch: async (url) => {
      captured = String(url);
      return jsonResponse(READY_STATE);
    },
  });
  await client.getState({ file: { resourceKey: 'K', version: 'V' } });
  const u = new URL(captured);
  assert.equal(u.searchParams.get('profile_id'), DEFAULT_PROFILE_ID);
});

test('requestGenerate 发送 snake_case body + Idempotency-Key', async () => {
  let captured;
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    fetch: async (_url, init) => {
      captured = init;
      return jsonResponse(READY_STATE);
    },
  });

  await client.requestGenerate({
    file: { resourceKey: 'K', version: 'V' },
    profileId: 'my',
    idempotencyKey: 'idem-1',
  });

  const body = JSON.parse(captured.body);
  assert.deepEqual(body, {
    file_ref: { resource_key: 'K', version: 'V' },
    profile_id: 'my',
  });
  assert.equal(captured.headers[IDEMPOTENCY_KEY_HEADER], 'idem-1');
  assert.equal(captured.headers['content-type'], 'application/json');
});

test('自定义 headers() 会被合并到每个请求', async () => {
  let captured;
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    headers: async () => ({ authorization: 'Bearer T' }),
    fetch: async (_url, init) => {
      captured = init;
      return jsonResponse(READY_STATE);
    },
  });
  await client.getState({ file: { resourceKey: 'K', version: 'V' } });
  assert.equal(captured.headers['authorization'], 'Bearer T');
});

test('非 2xx 响应会 normalize 为 PreviewError，并带 requestId', async () => {
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    fetch: async () =>
      errorResponse(503, {
        error: {
          code: ERROR_CODES.SERVICE_UNAVAILABLE,
          message: 'busy',
          retryable: true,
        },
      }),
  });

  await assert.rejects(
    () => client.getState({ file: { resourceKey: 'K', version: 'V' } }),
    (err) => {
      assert.ok(isPreviewError(err));
      assert.equal(err.code, ERROR_CODES.SERVICE_UNAVAILABLE);
      assert.equal(err.retryable, true);
      assert.equal(err.requestId, 'req-xyz');
      return true;
    },
  );
});

test('fetch 抛错映射为 NETWORK_ERROR 且可重试', async () => {
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    fetch: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(
    () => client.getState({ file: { resourceKey: 'K', version: 'V' } }),
    (err) => {
      assert.equal(err.code, ERROR_CODES.NETWORK_ERROR);
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test('fetch 抛 AbortError 映射为 REQUEST_ABORTED', async () => {
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    fetch: async () => {
      const e = new Error('abort');
      e.name = 'AbortError';
      throw e;
    },
  });
  await assert.rejects(
    () => client.getState({ file: { resourceKey: 'K', version: 'V' } }),
    (err) => {
      assert.equal(err.code, ERROR_CODES.REQUEST_ABORTED);
      return true;
    },
  );
});

test('fetchArtifact 走二进制路径，返回 ArrayBuffer', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    fetch: async (_url, init) => {
      assert.equal(init.headers['accept'], 'application/octet-stream');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => bytes.buffer,
        json: async () => {
          throw new Error('should not be called');
        },
      };
    },
  });

  const buf = await client.fetchArtifact({
    previewId: 'p1',
    publishedRevision: 3,
    artifactId: 'a/b',
  });
  assert.ok(buf instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(buf), bytes);
});

test('RequestQueue 保证请求串行 maxParallel=1 时严格顺序', async () => {
  let inflight = 0;
  let maxSeen = 0;
  let done = 0;
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    maxParallelRequests: 1,
    fetch: async () => {
      inflight += 1;
      maxSeen = Math.max(maxSeen, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      done += 1;
      return jsonResponse(READY_STATE);
    },
  });

  await Promise.all([
    client.getState({ file: { resourceKey: 'K', version: '1' } }),
    client.getState({ file: { resourceKey: 'K', version: '2' } }),
    client.getState({ file: { resourceKey: 'K', version: '3' } }),
  ]);
  assert.equal(done, 3);
  assert.equal(maxSeen, 1);
});

test('AbortSignal 已 aborted 时立刻 reject', async () => {
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    fetch: async () => jsonResponse(READY_STATE),
  });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      client.getState({
        file: { resourceKey: 'K', version: 'V' },
        signal: ac.signal,
      }),
    (err) => err.name === 'AbortError',
  );
});

function makeHeaders(map) {
  const lowered = {};
  for (const k of Object.keys(map)) lowered[k.toLowerCase()] = map[k];
  return {
    get: (name) => lowered[String(name).toLowerCase()] ?? null,
  };
}

test('fetchArtifact + artifactCache: 命中新鲜条目直接返回，无网络请求', async () => {
  const cache = createArtifactCache();
  let calls = 0;
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    artifactCache: cache,
    fetch: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        headers: makeHeaders({
          etag: '"v1"',
          'cache-control': 'public, max-age=3600',
          'content-type': 'application/pdf',
        }),
        arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
      };
    },
  });

  const buf1 = await client.fetchArtifact({
    previewId: 'p1',
    publishedRevision: 3,
    artifactId: 'a',
  });
  const buf2 = await client.fetchArtifact({
    previewId: 'p1',
    publishedRevision: 3,
    artifactId: 'a',
  });
  assert.equal(calls, 1);
  assert.deepEqual(new Uint8Array(buf1), new Uint8Array([9, 9]));
  assert.deepEqual(new Uint8Array(buf2), new Uint8Array([9, 9]));
});

test('fetchArtifact + artifactCache: 过期条目发起 revalidate，304 复用旧数据', async () => {
  const cache = createArtifactCache();
  let calls = 0;
  let capturedInit;
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    artifactCache: cache,
    fetch: async (_url, init) => {
      calls += 1;
      capturedInit = init;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: makeHeaders({
            etag: '"v1"',
            // max-age=0 → 立刻过期
            'cache-control': 'max-age=0',
            'content-type': 'application/pdf',
          }),
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      }
      // 第二次发起时应携带 If-None-Match: "v1"
      assert.equal(init.headers['if-none-match'], '"v1"');
      return {
        ok: false,
        status: 304,
        headers: makeHeaders({
          'cache-control': 'max-age=60',
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({}),
      };
    },
  });

  const first = await client.fetchArtifact({
    previewId: 'p1',
    publishedRevision: 3,
    artifactId: 'a',
  });
  const second = await client.fetchArtifact({
    previewId: 'p1',
    publishedRevision: 3,
    artifactId: 'a',
  });

  assert.deepEqual(new Uint8Array(first), new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(second), new Uint8Array([1, 2, 3]));
  assert.equal(calls, 2);
  assert.ok(capturedInit);
});

test('fetchArtifact: 304 但无本地缓存时抛 PROTOCOL_ERROR', async () => {
  const client = createHttpPreviewClient({
    baseUrl: 'https://host.example.com',
    fetch: async () => ({
      ok: false,
      status: 304,
      headers: makeHeaders({}),
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({}),
    }),
  });
  await assert.rejects(
    () =>
      client.fetchArtifact({
        previewId: 'p1',
        publishedRevision: 3,
        artifactId: 'a',
        etag: '"v1"',
      }),
    (err) => {
      assert.equal(err.code, ERROR_CODES.PROTOCOL_ERROR);
      return true;
    },
  );
});
