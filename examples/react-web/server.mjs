// examples/react-web · 一键脚本：
//   1) 在 127.0.0.1:8787 启一个 in-memory host（复用 node-inmemory 的桩组合）
//   2) 执行 vite dev（默认 5173），并将 /v1/* 反向代理到 host
// 浏览器打开 vite 输出的 URL 即可看到 <FilePreview>。

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  allowAllAuthorize,
  InMemorySourceProvider,
  InMemoryArtifactStorage,
  InMemoryIdempotencyStore,
  InMemoryStore,
} from '@unipat/file-preview-node/inmemory';
import {
  createPreviewHost,
  createHttpHandler,
  Orchestrator,
} from '@unipat/file-preview-node';
import { DemoRunner } from './demo-runner.mjs';

const NAMESPACE = 'demo';
const HOST_PORT = Number(process.env.HOST_PORT ?? 8787);
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);

const logger = {
  log(level, event, fields) {
    if (level === 'debug') return;
    console.log(`[host:${level}] ${event}`, fields ?? {});
  },
};

const sourceProvider = new InMemorySourceProvider();
sourceProvider.register({
  resourceKey: 'files/hello.txt',
  version: 'v1',
  filename: 'hello.txt',
  extension: 'txt',
  bytes: new TextEncoder().encode(
    '这是一段用于 react-web demo 的示例文本，包含中文与 English。',
  ),
});
sourceProvider.register({
  resourceKey: 'files/notes.md',
  version: 'v1',
  filename: 'notes.md',
  extension: 'md',
  bytes: new TextEncoder().encode(
    '# hello\n\n- item 1\n- item 2\n\ntext preview via demo runner.',
  ),
});
sourceProvider.register({
  resourceKey: 'files/sample.pdf',
  version: 'v1',
  filename: 'sample.pdf',
  extension: 'pdf',
  bytes: new TextEncoder().encode('placeholder-source-bytes-for-pdf-demo'),
});
sourceProvider.register({
  resourceKey: 'files/sheet.xlsx',
  version: 'v1',
  filename: 'sheet.xlsx',
  extension: 'xlsx',
  bytes: new TextEncoder().encode('placeholder-source-bytes-for-xlsx-demo'),
});
sourceProvider.register({
  resourceKey: 'files/photo.png',
  version: 'v1',
  filename: 'photo.png',
  extension: 'png',
  bytes: new TextEncoder().encode('placeholder-source-bytes-for-png-demo'),
});
sourceProvider.register({
  resourceKey: 'files/hello.html',
  version: 'v1',
  filename: 'hello.html',
  extension: 'html',
  bytes: new TextEncoder().encode(
    `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>Hello HTML</title></head>
  <body>
    <h1>Hello HTML 预览</h1>
    <p>这是通过 <code>HtmlViewer</code> 在 sandbox iframe 里渲染的样本。</p>
    <ul>
      <li>支持 <kbd>F</kbd> 全屏 / <kbd>Esc</kbd> 退出 / <kbd>R</kbd> 刷新</li>
      <li>不会执行任何脚本（sandbox 限制 + runner 侧白名单化）</li>
    </ul>
  </body>
</html>`,
  ),
});
sourceProvider.register({
  resourceKey: 'files/demo.ipynb',
  version: 'v1',
  filename: 'demo.ipynb',
  extension: 'ipynb',
  bytes: new TextEncoder().encode(
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
      cells: [
        {
          cell_type: 'markdown',
          metadata: {},
          source: [
            '# Notebook 预览 Demo\n',
            '\n',
            '这是一个用于演示 `NotebookViewer` 的样本。\n',
            '- 支持 `j` / `k` 上下移动\n',
            '- 支持 `n` / `m` 跳到同类型 cell\n',
          ],
        },
        {
          cell_type: 'code',
          metadata: {},
          execution_count: 1,
          source: ['print("hello from notebook demo")\n', '1 + 2\n'],
          outputs: [
            {
              output_type: 'stream',
              name: 'stdout',
              text: 'hello from notebook demo\n',
            },
            {
              output_type: 'execute_result',
              execution_count: 1,
              data: { 'text/plain': '3' },
            },
          ],
        },
        {
          cell_type: 'code',
          metadata: {},
          execution_count: 2,
          source: ['raise ValueError("this is a demo error")\n'],
          outputs: [
            {
              output_type: 'error',
              ename: 'ValueError',
              evalue: 'this is a demo error',
              traceback: [
                'Traceback (most recent call last):',
                '  File "<stdin>", line 1, in <module>',
                'ValueError: this is a demo error',
              ],
            },
          ],
        },
      ],
    }),
  ),
});

const store = new InMemoryStore({ namespace: NAMESPACE });
const artifactStorage = new InMemoryArtifactStorage();
const runner = new DemoRunner();
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

const handler = createHttpHandler({
  host,
  namespace: NAMESPACE,
  logger,
  resolvePrincipal: async () => ({
    userId: 'demo-user',
    tenantId: 'demo-tenant',
    roles: ['viewer'],
  }),
});

const server = createServer(handler);
await new Promise((resolve) => server.listen(HOST_PORT, '127.0.0.1', resolve));
console.log(`[host] listening at http://127.0.0.1:${HOST_PORT}`);
orchestrator.start();

const vite = spawn(
  'pnpm',
  ['exec', 'vite', '--port', String(VITE_PORT), '--strictPort'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOST_URL: `http://127.0.0.1:${HOST_PORT}`,
    },
  },
);

const shutdown = async (code = 0) => {
  try {
    await orchestrator.stop();
  } catch {}
  await new Promise((resolve) => server.close(() => resolve()));
  if (!vite.killed) vite.kill('SIGTERM');
  process.exit(code);
};

vite.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
