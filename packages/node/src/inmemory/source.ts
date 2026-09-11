import type { FileRef } from '@unipat/file-preview-contracts';
import { createHash } from 'node:crypto';
import type {
  ResolvedSource,
  SourceProvider,
  SourceRange,
  SourceReadResult,
  SourceScope,
} from '../ports.js';
import { HostErrors } from '../errors.js';

interface RegisteredFile {
  readonly resourceKey: string;
  readonly version: string;
  readonly filename: string;
  readonly extension: string;
  readonly bytes: Uint8Array;
}

/**
 * 用内存 Map 保存 (resourceKey, version) → 二进制的最简 SourceProvider。
 * 主要用于本地 e2e。
 */
export class InMemorySourceProvider implements SourceProvider {
  private readonly files = new Map<string, RegisteredFile>();

  register(file: {
    resourceKey: string;
    version: string;
    filename: string;
    extension: string;
    bytes: Uint8Array;
  }): void {
    const key = makeKey(file.resourceKey, file.version);
    this.files.set(key, {
      resourceKey: file.resourceKey,
      version: file.version,
      filename: file.filename,
      extension: file.extension,
      bytes: file.bytes,
    });
  }

  async resolve(
    _scope: SourceScope,
    file: FileRef,
    _signal: AbortSignal,
  ): Promise<ResolvedSource> {
    const rec = this.files.get(makeKey(file.resourceKey, file.version));
    if (!rec) throw HostErrors.resourceNotFound();
    return {
      resourceKey: rec.resourceKey,
      version: rec.version,
      filename: rec.filename,
      extension: rec.extension,
      sizeBytes: rec.bytes.byteLength,
      expectedSha256: sha256Hex(rec.bytes),
      handle: { kind: 'inmemory', key: makeKey(rec.resourceKey, rec.version) },
    };
  }

  async open(
    source: ResolvedSource,
    options: { signal: AbortSignal; range?: SourceRange },
  ): Promise<SourceReadResult> {
    const rec = this.files.get(
      makeKey(source.resourceKey, source.version),
    );
    if (!rec) throw HostErrors.sourceUnavailable();

    const slice = options.range
      ? rec.bytes.subarray(options.range.start, options.range.endInclusive + 1)
      : rec.bytes;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(slice);
        controller.close();
      },
    });

    return {
      stream,
      sizeBytes: slice.byteLength,
      version: rec.version,
    };
  }

  async isAvailable(
    source: ResolvedSource,
    _signal: AbortSignal,
  ): Promise<boolean> {
    return this.files.has(makeKey(source.resourceKey, source.version));
  }
}

function makeKey(resourceKey: string, version: string): string {
  return `${resourceKey}@${version}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
