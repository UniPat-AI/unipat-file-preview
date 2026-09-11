export interface ArtifactCacheEntry {
  readonly data: ArrayBuffer;
  readonly etag?: string;
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly storedAt: number;
  readonly maxAgeMs?: number;
}

export interface ArtifactCache {
  get(key: string): ArtifactCacheEntry | undefined;
  set(key: string, entry: ArtifactCacheEntry): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
  readonly byteSize: number;
}

export interface CreateArtifactCacheOptions {
  /** 最多缓存条数（LRU）。默认 128。 */
  readonly maxEntries?: number;
  /** 最大总字节数。默认 64 MiB。超出则按 LRU 顺序驱逐。 */
  readonly maxBytes?: number;
  /** 当前时间获取器（便于测试注入）。默认 `Date.now`。 */
  readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export function createArtifactCache(
  options: CreateArtifactCacheOptions = {},
): ArtifactCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries 必须为 >=1 的整数');
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new Error('maxBytes 必须为 >=1 的正数');
  }
  const now = options.now ?? (() => Date.now());

  // Map 保持插入顺序 —— 通过 delete+set 提到队尾表示"最近使用"。
  const store = new Map<string, ArtifactCacheEntry>();
  let byteSize = 0;

  const evictIfNeeded = () => {
    // 按最旧插入项驱逐，直到满足容量和字节上限。
    while ((store.size > maxEntries || byteSize > maxBytes) && store.size > 0) {
      const iter = store.keys().next();
      if (iter.done) break;
      const oldestKey = iter.value;
      const entry = store.get(oldestKey);
      store.delete(oldestKey);
      if (entry) byteSize -= entry.data.byteLength;
    }
  };

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      // touch: 移到末尾
      store.delete(key);
      store.set(key, entry);
      return entry;
    },
    set(key, entry) {
      const prev = store.get(key);
      if (prev) {
        byteSize -= prev.data.byteLength;
        store.delete(key);
      }
      const stored: ArtifactCacheEntry = {
        ...entry,
        storedAt: typeof entry.storedAt === 'number' ? entry.storedAt : now(),
      };
      store.set(key, stored);
      byteSize += stored.data.byteLength;
      evictIfNeeded();
    },
    delete(key) {
      const prev = store.get(key);
      if (prev) {
        byteSize -= prev.data.byteLength;
        store.delete(key);
      }
    },
    clear() {
      store.clear();
      byteSize = 0;
    },
    get size() {
      return store.size;
    },
    get byteSize() {
      return byteSize;
    },
  };
}

/** 判断一条 cache 条目是否仍然新鲜（未超过 max-age）。 */
export function isFresh(
  entry: ArtifactCacheEntry,
  nowMs: number = Date.now(),
): boolean {
  const maxAge = entry.maxAgeMs ?? parseMaxAgeMs(entry.cacheControl);
  if (maxAge === undefined) return false;
  return nowMs - entry.storedAt < maxAge;
}

/** 从 Cache-Control 首选项解析 `max-age=N`（返回毫秒），无则 undefined。 */
export function parseMaxAgeMs(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const m = /(?:^|,\s*)max-age\s*=\s*(\d+)/i.exec(header);
  if (!m) return undefined;
  const seconds = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(seconds)) return undefined;
  return seconds * 1000;
}
