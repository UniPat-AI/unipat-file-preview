import { createHash } from 'node:crypto';
import type {
  ArtifactListPage,
  ArtifactPutResult,
  ArtifactStat,
  ArtifactStorage,
} from '../ports.js';
import { HostErrors } from '../errors.js';

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mediaType: string;
}

export class InMemoryArtifactStorage implements ArtifactStorage {
  private readonly objects = new Map<string, StoredObject>();
  private readonly defaultMediaType: string;

  constructor(options?: { defaultMediaType?: string }) {
    this.defaultMediaType =
      options?.defaultMediaType ?? 'application/octet-stream';
  }

  async stat(key: string, _signal: AbortSignal): Promise<ArtifactStat | null> {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return {
      sizeBytes: obj.bytes.byteLength,
      sha256: obj.sha256,
      mediaType: obj.mediaType,
    };
  }

  async openRange(
    key: string,
    start: number,
    endInclusive: number,
    _signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const obj = this.objects.get(key);
    if (!obj) throw HostErrors.resourceNotFound();
    const slice = obj.bytes.subarray(start, endInclusive + 1);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(slice);
        controller.close();
      },
    });
  }

  async put(
    key: string,
    stream: ReadableStream<Uint8Array>,
    expectedSize: number,
    expectedSha256: string,
    _signal: AbortSignal,
  ): Promise<ArtifactPutResult> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const bytes = concat(chunks, total);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (total !== expectedSize) {
      throw HostErrors.protocolError(
        `派生对象大小不一致：期望 ${expectedSize}，实际 ${total}`,
      );
    }
    if (sha256 !== expectedSha256) {
      throw HostErrors.protocolError('派生对象摘要不一致');
    }
    this.objects.set(key, {
      bytes,
      sha256,
      mediaType: this.defaultMediaType,
    });
    return { key, sizeBytes: total, sha256 };
  }

  /** 供 orchestrator 直接写入已经计算好摘要的候选产物，避免多写一遍摘要计算。 */
  putDirect(
    key: string,
    bytes: Uint8Array,
    mediaType: string,
  ): ArtifactPutResult {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.objects.set(key, { bytes, sha256, mediaType });
    return { key, sizeBytes: bytes.byteLength, sha256 };
  }

  async delete(key: string, _signal: AbortSignal): Promise<boolean> {
    return this.objects.delete(key);
  }

  async list(
    prefix: string,
    cursor: string | null,
    _signal: AbortSignal,
  ): Promise<ArtifactListPage> {
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const startIndex = cursor ? keys.indexOf(cursor) + 1 : 0;
    const page = keys.slice(startIndex, startIndex + 100);
    return {
      objects: page.map((k) => ({
        key: k,
        sizeBytes: this.objects.get(k)!.bytes.byteLength,
      })),
      nextCursor:
        startIndex + page.length < keys.length
          ? (page[page.length - 1] ?? null)
          : null,
    };
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
