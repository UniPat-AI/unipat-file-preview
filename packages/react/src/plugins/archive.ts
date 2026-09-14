import type { FileSource } from './types.js';

/** Browser-only, read-only archive limits. Limits apply at every nesting level. */
export interface ArchiveLimits {
  maxInputBytes: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  maxDepth: number;
  timeoutMs: number;
}
export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxInputBytes: 32 * 1024 * 1024, maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024, maxEntries: 2000, maxDepth: 3, timeoutMs: 30000,
});
export function archiveLimits(overrides?: Partial<ArchiveLimits>): ArchiveLimits {
  const result = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const value of Object.values(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('压缩文件限制必须为正整数');
  }
  return result;
}
export interface ArchiveEntry { path: string; size: number; directory: boolean; read(signal?: AbortSignal): Promise<Blob> }

async function collect(stream: ReadableStream<Uint8Array>, max: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('文件解压后超过预览大小限制');
      chunks.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return data;
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function inflate(data: Uint8Array, format: 'gzip' | 'deflate-raw', max: number, signal?: AbortSignal) {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持压缩文件预览，请升级浏览器');
  return collect(new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream(format)), max, signal);
}
export async function readArchiveSource(src: FileSource, limits: ArchiveLimits, signal?: AbortSignal) {
  if (typeof src !== 'string') {
    if (src.size > limits.maxInputBytes) throw new Error('压缩文件超过预览大小限制');
    return collect(src.stream(), limits.maxInputBytes, signal);
  }
  const response = await fetch(src, { signal: signal ?? null });
  if (!response.ok || !response.body) throw new Error(`无法读取压缩文件：HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > limits.maxInputBytes) { await response.body.cancel(); throw new Error('压缩文件超过预览大小限制'); }
  return collect(response.body, limits.maxInputBytes, signal);
}
export async function readGzip(data: Uint8Array, limits: ArchiveLimits, signal?: AbortSignal) {
  if (data[0] !== 31 || data[1] !== 139) throw new Error('无效的 GZIP 文件');
  return new Blob([await inflate(data, 'gzip', Math.min(limits.maxEntryBytes, limits.maxTotalBytes), signal)]);
}
function safePath(path: string) {
  if (!path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some(p => p === '..' || p === '.')) throw new Error('压缩包包含不安全的文件路径');
  return path;
}
function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Reads central directory only; member bytes are decompressed on selection. ZIP64/encryption are deliberately unsupported. */
export function readZip(data: Uint8Array, limits: ArchiveLimits): ArchiveEntry[] {
  if (data.length > limits.maxInputBytes) throw new Error('压缩文件超过预览大小限制');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === data.length) { end = i; break; }
  }
  if (end < 0) throw new Error('无效或不完整的 ZIP 文件');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directoryStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || directoryStart === 0xffffffff) throw new Error('暂不支持分卷或 ZIP64 压缩包');
  if (count > limits.maxEntries) throw new Error('压缩包文件数量超过预览限制');
  if (directoryStart + directorySize !== end) throw new Error('无效的 ZIP 目录');
  const entries: ArchiveEntry[] = [], paths = new Set<string>();
  let pos = directoryStart, total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) throw new Error('无效的 ZIP 条目');
    const flags = view.getUint16(pos + 8, true), method = view.getUint16(pos + 10, true), crc = view.getUint32(pos + 16, true), compressed = view.getUint32(pos + 20, true), size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true), extra = view.getUint16(pos + 30, true), comment = view.getUint16(pos + 32, true), offset = view.getUint32(pos + 42, true);
    if (pos + 46 + nameLength + extra + comment > end) throw new Error('无效的 ZIP 目录长度');
    const path = safePath(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(pos + 46, pos + 46 + nameLength)));
    const unixType = (view.getUint32(pos + 38, true) >>> 16) & 0xf000;
    if (flags & 1) throw new Error('暂不支持加密 ZIP 文件');
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) throw new Error('不支持符号链接或特殊文件');
    if (view.getUint16(pos + 34, true) || compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('暂不支持分卷或 ZIP64 压缩包');
    if (method !== 0 && method !== 8) throw new Error('不支持此 ZIP 压缩算法');
    total += size;
    if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) throw new Error('压缩包解压大小超过预览限制');
    const key = path.replace(/\/$/, '');
    if (paths.has(key)) throw new Error('压缩包包含重复路径');
    paths.add(key);
    if (offset + 30 > directoryStart || view.getUint32(offset, true) !== 0x04034b50) throw new Error('无效的 ZIP 文件头');
    const localNameLength = view.getUint16(offset + 26, true), start = offset + 30 + localNameLength + view.getUint16(offset + 28, true);
    if (start + compressed > directoryStart || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method || new TextDecoder().decode(data.subarray(offset + 30, offset + 30 + localNameLength)) !== path) throw new Error('ZIP 文件头与目录不一致');
    entries.push({ path, size, directory: path.endsWith('/'), async read(signal) {
      signal?.throwIfAborted();
      const bytes = method === 0 ? data.slice(start, start + compressed) : await inflate(data.subarray(start, start + compressed), 'deflate-raw', Math.min(size, limits.maxEntryBytes), signal);
      if (bytes.length !== size || crc32(bytes) !== crc) throw new Error('ZIP 文件完整性校验失败');
      return new Blob([bytes]);
    } });
    pos += 46 + nameLength + extra + comment;
  }
  if (pos !== end) throw new Error('ZIP 目录条目数量不匹配');
  return entries;
}

/** POSIX TAR directory, including PAX paths and GNU long names. Never writes to disk. */
export function readTar(data: Uint8Array, limits: ArchiveLimits): ArchiveEntry[] {
  if (data.length > limits.maxInputBytes) throw new Error('压缩文件超过预览大小限制');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = (bytes: Uint8Array) => decoder.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
  const octal = (bytes: Uint8Array) => {
    const value = text(bytes).trim();
    if (value && !/^[0-7]+$/.test(value)) throw new Error('不支持的 TAR 数字格式');
    const n = parseInt(value || '0', 8);
    if (!Number.isSafeInteger(n)) throw new Error('TAR 数值超过限制');
    return n;
  };
  const entries: ArchiveEntry[] = [], paths = new Set<string>();
  let pos = 0, total = 0, headers = 0;
  let pending: Record<string, string> = {}, global: Record<string, string> = {};
  while (pos + 512 <= data.length) {
    const header = data.subarray(pos, pos + 512);
    if (header.every(b => b === 0)) {
      if (Object.keys(pending).length || pos + 1024 > data.length || data.subarray(pos).some(b => b !== 0)) throw new Error('TAR 结束标记无效');
      return entries;
    }
    if (++headers > limits.maxEntries) throw new Error('压缩包文件数量超过预览限制');
    const checksum = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== octal(header.subarray(148, 156))) throw new Error('TAR 文件头校验失败');
    const kind = String.fromCharCode(header[156] || 48);
    const attrs = { ...global, ...pending };
    const metadata = kind === 'x' || kind === 'g' || kind === 'L';
    const rawSize = octal(header.subarray(124, 136));
    const size = !metadata && attrs.size !== undefined ? Number(attrs.size) : rawSize;
    if (!Number.isSafeInteger(size) || size < 0 || (!metadata && attrs.size !== undefined && !/^\d+$/.test(attrs.size))) throw new Error('TAR 文件大小无效');
    const start = pos + 512, end = start + size, next = start + Math.ceil(size / 512) * 512;
    if (next > data.length) throw new Error('TAR 文件内容不完整');
    total += size;
    if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) throw new Error('压缩包解压大小超过预览限制');
    if (metadata) {
      if (kind === 'L') pending.path = text(data.subarray(start, end)).replace(/\n$/, '');
      else {
        const parsed: Record<string, string> = {};
        let p = start;
        while (p < end) {
          const space = data.indexOf(32, p);
          if (space < p || space >= end) throw new Error('无效的 PAX 记录');
          const lengthText = decoder.decode(data.subarray(p, space));
          const length = Number(lengthText);
          if (!/^\d+$/.test(lengthText) || !Number.isSafeInteger(length) || length <= space - p + 2 || p + length > end || data[p + length - 1] !== 10) throw new Error('无效的 PAX 长度');
          const record = decoder.decode(data.subarray(space + 1, p + length - 1)), equals = record.indexOf('=');
          if (equals <= 0) throw new Error('无效的 PAX 属性');
          const key = record.slice(0, equals), value = record.slice(equals + 1);
          if (/sparse/i.test(key) || key === 'SCHILY.filetype') throw new Error('暂不支持稀疏 TAR 文件');
          if (['path', 'size', 'linkpath'].includes(key)) parsed[key] = value;
          p += length;
        }
        if (kind === 'g') global = { ...global, ...parsed }; else pending = { ...pending, ...parsed };
      }
    } else {
      if (kind !== '0' && kind !== '5') throw new Error('不支持 TAR 符号链接、硬链接或特殊文件');
      if (attrs.linkpath) throw new Error('不支持 TAR 链接');
      const prefix = text(header.subarray(257, 262)) === 'ustar' ? text(header.subarray(345, 500)) : '';
      const rawPath = attrs.path ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join('/');
      const directory = kind === '5';
      // tar -cf archive.tar . commonly emits ./ paths; normalize only leading ./.
      const normalized = rawPath.replace(/^(\.\/)+/, '').replace(/\/$/, '');
      if (!normalized && directory) { pending = {}; pos = next; continue; }
      const path = safePath(normalized);
      if (paths.has(path)) throw new Error('压缩包包含重复路径');
      if (directory && size !== 0) throw new Error('TAR 目录大小无效');
      paths.add(path);
      entries.push({ path: directory ? `${path}/` : path, directory, size, async read(signal) {
        signal?.throwIfAborted(); return new Blob([new Uint8Array(data.subarray(start, end))]);
      } });
      pending = {};
    }
    pos = next;
  }
  throw new Error('TAR 文件缺少结束标记或已截断');
}

export async function readTarGzip(data: Uint8Array, limits: ArchiveLimits, signal?: AbortSignal) {
  // The decompressed TAR is a container, not a single member. Bound it separately.
  const tar = await inflate(data, 'gzip', limits.maxTotalBytes, signal);
  signal?.throwIfAborted();
  return readTar(tar, { ...limits, maxInputBytes: limits.maxTotalBytes });
}
