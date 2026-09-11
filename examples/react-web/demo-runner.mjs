// examples/react-web/demo-runner.mjs
// 按扩展名产不同 representation 的 mock runner。仅用于浏览器 demo。
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MINIMAL_PDF_BYTES = buildMinimalPdf();
const TINY_PNG_BYTES = buildTinyPng();

export class DemoRunner {
  async run(input, readOnlySource, outputDirectory, _limits, signal) {
    throwIfAborted(signal);
    const ext = (input.source.extension || '').toLowerCase();

    let result;
    if (ext === 'pdf') {
      result = await emitPdf(outputDirectory);
    } else if (
      ext === 'png' ||
      ext === 'jpg' ||
      ext === 'jpeg' ||
      ext === 'gif'
    ) {
      result = await emitGallery(outputDirectory);
    } else if (ext === 'xlsx' || ext === 'csv') {
      result = await emitTable(outputDirectory);
    } else if (ext === 'html' || ext === 'htm') {
      result = await emitHtml(readOnlySource, outputDirectory);
    } else if (ext === 'ipynb') {
      result = await emitNotebook(readOnlySource, outputDirectory);
    } else {
      result = await emitText(input, readOnlySource, outputDirectory);
    }
    throwIfAborted(signal);
    return result;
  }

  async cancel() {
    return true;
  }

  async capabilities() {
    return {
      protocolVersions: ['1.0'],
      imageDigest: 'sha256:demo-runner',
      fontDigest: 'sha256:none',
      supportedFormats: [
        'txt',
        'md',
        'pdf',
        'png',
        'xlsx',
        'csv',
        'html',
        'ipynb',
      ],
    };
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const reason = signal.reason ?? new Error('aborted');
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

async function emitPdf(outputDirectory) {
  const relPath = 'entry.pdf';
  const bytes = MINIMAL_PDF_BYTES;
  await writeFile(join(outputDirectory, relPath), bytes);
  const sha256 = sha256Hex(bytes);
  return {
    manifest: {
      default_representation_id: 'pdf',
      representations: [
        {
          id: 'pdf',
          kind: 'pdf',
          label: 'PDF 预览',
          status: 'ready',
          completeness: 'complete',
          affects_completeness: true,
          entry_artifact_relative_path: relPath,
          coverage: { unit: 'pages', shown: 1, total: 1 },
          warnings: [],
          error: null,
        },
      ],
      capabilities: {
        search_scope: 'document',
        static_only: true,
        has_text_layer: true,
      },
    },
    artifacts: [
      {
        relativePath: relPath,
        role: 'entry',
        mediaType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
      },
    ],
    warnings: [],
  };
}

async function emitGallery(outputDirectory) {
  const items = [
    { rel: 'img-1.png', bytes: TINY_PNG_BYTES },
    { rel: 'img-2.png', bytes: TINY_PNG_BYTES },
    { rel: 'img-3.png', bytes: TINY_PNG_BYTES },
  ];
  for (const it of items) {
    await writeFile(join(outputDirectory, it.rel), it.bytes);
  }
  const artifacts = items.map((it, i) => ({
    relativePath: it.rel,
    role: i === 0 ? 'entry' : 'auxiliary',
    mediaType: 'image/png',
    sizeBytes: it.bytes.byteLength,
    sha256: sha256Hex(it.bytes),
  }));
  return {
    manifest: {
      default_representation_id: 'gallery',
      representations: [
        {
          id: 'gallery',
          kind: 'gallery',
          label: '图像预览',
          status: 'ready',
          completeness: 'complete',
          affects_completeness: true,
          entry_artifact_relative_path: items[0].rel,
          coverage: {
            unit: 'frames',
            shown: items.length,
            total: items.length,
          },
          warnings: [],
          error: null,
        },
      ],
      capabilities: { search_scope: 'none', static_only: true },
    },
    artifacts,
    warnings: [],
  };
}

async function emitTable(outputDirectory) {
  const relPath = 'entry.json';
  const body = new TextEncoder().encode(
    JSON.stringify({ note: 'sheet-window demo (stub)' }),
  );
  await writeFile(join(outputDirectory, relPath), body);
  return {
    manifest: {
      default_representation_id: 'table',
      representations: [
        {
          id: 'table',
          kind: 'table',
          label: '表格预览',
          status: 'ready',
          completeness: 'partial',
          affects_completeness: true,
          entry_artifact_relative_path: relPath,
          coverage: { unit: 'rows', shown: 0, total: null, scope: 'sheet1' },
          warnings: [],
          error: null,
        },
      ],
      capabilities: { search_scope: 'current_window', static_only: false },
    },
    artifacts: [
      {
        relativePath: relPath,
        role: 'entry',
        mediaType: 'application/json',
        sizeBytes: body.byteLength,
        sha256: sha256Hex(body),
      },
    ],
    warnings: [
      {
        code: 'sheet-windows.stub',
        message: 'sheet-windows endpoint not yet implemented in demo host',
        severity: 'info',
      },
    ],
  };
}

async function emitHtml(readOnlySource, outputDirectory) {
  const raw = await readFile(readOnlySource.path);
  const sanitized = sanitizeHtml(raw.toString('utf-8'));
  const relPath = 'entry.html';
  const bytes = new TextEncoder().encode(sanitized);
  await writeFile(join(outputDirectory, relPath), bytes);
  return {
    manifest: {
      default_representation_id: 'html',
      representations: [
        {
          id: 'html',
          kind: 'html',
          label: 'HTML 预览',
          status: 'ready',
          completeness: 'complete',
          affects_completeness: true,
          entry_artifact_relative_path: relPath,
          coverage: {
            unit: 'chars',
            shown: sanitized.length,
            total: sanitized.length,
          },
          warnings: [],
          error: null,
        },
      ],
      capabilities: { search_scope: 'document', static_only: true },
    },
    artifacts: [
      {
        relativePath: relPath,
        role: 'entry',
        mediaType: 'text/html; charset=utf-8',
        sizeBytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      },
    ],
    warnings: [],
  };
}

async function emitNotebook(readOnlySource, outputDirectory) {
  const raw = await readFile(readOnlySource.path);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf-8'));
  } catch {
    parsed = { nbformat: 4, nbformat_minor: 5, cells: [] };
  }
  const relPath = 'entry.ipynb';
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  await writeFile(join(outputDirectory, relPath), bytes);
  const cellCount = Array.isArray(parsed.cells) ? parsed.cells.length : 0;
  return {
    manifest: {
      default_representation_id: 'notebook',
      representations: [
        {
          id: 'notebook',
          kind: 'notebook',
          label: 'Notebook 预览',
          status: 'ready',
          completeness: 'complete',
          affects_completeness: true,
          entry_artifact_relative_path: relPath,
          coverage: { unit: 'cells', shown: cellCount, total: cellCount },
          warnings: [],
          error: null,
        },
      ],
      capabilities: { search_scope: 'document', static_only: true },
    },
    artifacts: [
      {
        relativePath: relPath,
        role: 'entry',
        mediaType: 'application/x-ipynb+json',
        sizeBytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      },
    ],
    warnings: [],
  };
}

// 极简 HTML 白名单化：去掉 script/style/on*= 内联事件，避免嵌入执行任意脚本。
function sanitizeHtml(input) {
  let out = input;
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  return out;
}

async function emitText(input, readOnlySource, outputDirectory) {
  const relPath = 'entry.txt';
  const body = new TextEncoder().encode(
    `[demo runner] preview=${input.previewId}\nsource=${input.source.filename}\nsize=${input.source.sizeBytes}\nsha256=${readOnlySource.sha256}\n`,
  );
  await writeFile(join(outputDirectory, relPath), body);
  return {
    manifest: {
      default_representation_id: 'text',
      representations: [
        {
          id: 'text',
          kind: 'text',
          label: '文本预览',
          status: 'ready',
          completeness: 'complete',
          affects_completeness: true,
          entry_artifact_relative_path: relPath,
          coverage: null,
          warnings: [],
          error: null,
        },
      ],
      capabilities: { search_scope: 'document', static_only: true },
    },
    artifacts: [
      {
        relativePath: relPath,
        role: 'entry',
        mediaType: 'text/plain; charset=utf-8',
        sizeBytes: body.byteLength,
        sha256: sha256Hex(body),
      },
    ],
    warnings: [],
  };
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// -------------------- 生成一个最简合法 PDF（1 页 Hello World） --------------------
function buildMinimalPdf() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const streamBody = 'BT /F1 24 Tf 40 100 Td (Hello demo PDF) Tj ET';
  const stream5 = `5 0 obj\n<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream\nendobj\n`;
  objects.push(stream5);

  const header = '%PDF-1.4\n%\xff\xff\xff\xff\n';
  let body = '';
  const offsets = [0];
  const encoder = new TextEncoder();
  let cursor = encoder.encode(header).byteLength;
  for (const obj of objects) {
    offsets.push(cursor);
    body += obj;
    cursor += encoder.encode(obj).byteLength;
  }
  const xrefOffset = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  const full = header + body + xref + trailer;
  return encoder.encode(full);
}

// -------------------- 生成一个 1x1 的 PNG（不同颜色由 crc 决定，简单起见都用红色） --------------------
function buildTinyPng() {
  // 直接内嵌一个已知合法的 1x1 红色 PNG（base64）
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  const bin = Buffer.from(base64, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
