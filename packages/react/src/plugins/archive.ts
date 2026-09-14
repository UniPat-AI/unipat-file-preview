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
