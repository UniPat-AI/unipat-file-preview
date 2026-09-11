import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_HTTP_BASE_PATH,
  HTTP_PROTOCOL_VERSION,
  IDEMPOTENCY_KEY_HEADER,
} from '@unipat/file-preview-contracts';
import type { PreviewHost } from './host.js';
import { HostErrors, isHostPreviewError } from './errors.js';
import type { HostPreviewError } from './errors.js';
import { encodeError } from './envelope.js';
import { deepCamelToSnake, deepSnakeToCamel } from './case-mapping.js';
import type { PreviewEventBus } from './event-bus.js';
import type { Logger, Principal, RequestContext } from './types.js';

export interface HttpHandlerOptions {
  readonly host: PreviewHost;
  readonly namespace: string;
  readonly resolvePrincipal: (req: IncomingMessage) => Promise<Principal>;
  readonly logger: Logger;
  readonly basePath?: string;
  /** 可选事件总线。传入后启用 SSE 端点。 */
  readonly eventBus?: PreviewEventBus;
}

export function createHttpHandler(
  options: HttpHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const basePath = normalizeBasePath(
    options.basePath ?? DEFAULT_HTTP_BASE_PATH,
  );
  const idempotencyHeader = IDEMPOTENCY_KEY_HEADER.toLowerCase();

  return (req, res) => {
    void handle(req, res).catch((err) => {
      options.logger.log('error', 'http.handler_crash', {
        message: (err as Error)?.message ?? String(err),
      });
      if (!res.headersSent) {
        writeJson(
          res,
          500,
          encodeError(res.getHeader('x-request-id')?.toString() ?? '', {
            code: 'UNKNOWN_ERROR' as const,
            message: (err as Error)?.message ?? '内部错误',
            retryable: false,
          }),
        );
      } else {
        res.end();
      }
    });
  };

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-preview-protocol', HTTP_PROTOCOL_VERSION);

    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    if (!url.pathname.startsWith(basePath)) {
      return writeError(
        res,
        requestId,
        HostErrors.resourceNotFound('路径不存在'),
      );
    }

    const subPath = url.pathname.slice(basePath.length) || '/';

    // 协议头校验（可选：客户端不一定发送时才要求）
    const clientProto = req.headers['x-preview-protocol'];
    if (clientProto && clientProto !== HTTP_PROTOCOL_VERSION) {
      return writeError(
        res,
        requestId,
        HostErrors.protocolError(
          `协议版本不兼容：客户端 ${String(clientProto)}, 服务端 ${HTTP_PROTOCOL_VERSION}`,
        ),
      );
    }

    let principal: Principal;
    try {
      principal = await options.resolvePrincipal(req);
    } catch (err) {
      return writeError(res, requestId, err);
    }

    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    req.on('close', () => abort.abort());
    const ctx: RequestContext = {
      requestId,
      namespace: options.namespace,
      principal,
      signal: abort.signal,
      ...(getHeader(req, idempotencyHeader)
        ? { idempotencyKey: String(getHeader(req, idempotencyHeader)) }
        : {}),
    };

    try {
      await route(req, res, url, subPath, ctx);
    } catch (err) {
      writeError(res, requestId, err);
    }
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    subPath: string,
    ctx: RequestContext,
  ): Promise<void> {
    const method = req.method ?? 'GET';

    // GET /state
    if (method === 'GET' && subPath === '/state') {
      const resourceKey = url.searchParams.get('resource_key');
      const version = url.searchParams.get('version');
      const profileId = url.searchParams.get('profile_id');
      if (!resourceKey || !version || !profileId) {
        throw HostErrors.protocolError('缺少 resource_key/version/profile_id');
      }
      const state = await options.host.getPreviewState(ctx, {
        file: { resourceKey, version },
        profileId,
      });
      return writeJson(res, 200, deepCamelToSnake(state));
    }

    // POST /generate
    if (method === 'POST' && subPath === '/generate') {
      const body = await readJsonBody(req);
      const camel = deepSnakeToCamel<{
        fileRef?: { resourceKey?: string; version?: string };
        profileId?: string;
      }>(body);
      if (
        !camel.fileRef?.resourceKey ||
        !camel.fileRef.version ||
        !camel.profileId
      ) {
        throw HostErrors.protocolError('generate 请求体字段不完整');
      }
      const idempotencyKey = ctx.idempotencyKey;
      const state = await options.host.ensurePreview(ctx, {
        file: {
          resourceKey: camel.fileRef.resourceKey,
          version: camel.fileRef.version,
        },
        profileId: camel.profileId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return writeJson(res, 200, deepCamelToSnake(state));
    }

    // GET /previews/{id}/events （SSE）
    const eventsMatch = /^\/previews\/([^/]+)\/events$/.exec(subPath);
    if (method === 'GET' && eventsMatch) {
      if (!options.eventBus) {
        throw HostErrors.resourceNotFound('SSE 未启用');
      }
      const previewId = decodeURIComponent(eventsMatch[1]!);
      // 触发一次 authorize + 404 检查
      const initialState = await options.host.getPreviewStateById(ctx, {
        previewId,
      });
      const lastEventIdHeader = getHeader(req, 'last-event-id');
      const lastEventId = lastEventIdHeader
        ? Number.parseInt(String(lastEventIdHeader), 10) || 0
        : 0;

      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();

      const emitEnvelope = (
        evt: import('@unipat/file-preview-contracts').PreviewEventEnvelope,
      ) => {
        const wireEnvelope = {
          event_id: evt.eventId,
          preview_id: evt.previewId,
          type: evt.type,
          state: evt.state ? deepCamelToSnake(evt.state) : null,
          emitted_at: evt.emittedAt,
        };
        const lines = [
          `id: ${evt.eventId}`,
          `event: ${evt.type}`,
          `data: ${JSON.stringify(wireEnvelope)}`,
          '',
          '',
        ];
        try {
          res.write(lines.join('\n'));
        } catch {
          /* connection closed */
        }
      };

      // 回放历史事件（严格大于 lastEventId）
      const missed = options.eventBus.since(previewId, lastEventId);
      if (missed.length === 0 && lastEventId === 0) {
        // 立即发送一次当前状态作为 "initial"
        const bootstrap = options.eventBus.publishState(
          previewId,
          initialState,
        );
        emitEnvelope(bootstrap);
      } else {
        for (const evt of missed) {
          emitEnvelope(evt);
        }
      }

      const subscription = options.eventBus.subscribe(previewId, (evt) => {
        emitEnvelope(evt);
      });

      const heartbeatTimer = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          /* connection closed */
        }
      }, 15_000);

      const cleanup = () => {
        clearInterval(heartbeatTimer);
        subscription.close();
        try {
          res.end();
        } catch {
          /* noop */
        }
      };
      req.on('close', cleanup);
      req.on('aborted', cleanup);
      return;
    }

    // POST /previews/{id}/cancel
    const cancelMatch = /^\/previews\/([^/]+)\/cancel$/.exec(subPath);
    if (method === 'POST' && cancelMatch) {
      const state = await options.host.cancel(ctx, {
        previewId: decodeURIComponent(cancelMatch[1]!),
      });
      return writeJson(res, 200, deepCamelToSnake(state));
    }

    // POST /previews/{id}/retry
    const retryMatch = /^\/previews\/([^/]+)\/retry$/.exec(subPath);
    if (method === 'POST' && retryMatch) {
      const state = await options.host.retry(ctx, {
        previewId: decodeURIComponent(retryMatch[1]!),
      });
      return writeJson(res, 200, deepCamelToSnake(state));
    }

    // POST /previews/{id}/clear
    const clearMatch = /^\/previews\/([^/]+)\/clear$/.exec(subPath);
    if (method === 'POST' && clearMatch) {
      await options.host.clear(ctx, {
        previewId: decodeURIComponent(clearMatch[1]!),
      });
      res.statusCode = 204;
      res.end();
      return;
    }

    // GET /previews/{id}/revisions/{rev}/manifest
    const manifestMatch =
      /^\/previews\/([^/]+)\/revisions\/(\d+)\/manifest$/.exec(subPath);
    if (method === 'GET' && manifestMatch) {
      const manifest = await options.host.getManifest(ctx, {
        previewId: decodeURIComponent(manifestMatch[1]!),
        publishedRevision: Number(manifestMatch[2]),
      });
      // manifest 已发布后不可变；使用 preview_id + published_revision 作为强 ETag
      const previewId = decodeURIComponent(manifestMatch[1]!);
      const rev = Number(manifestMatch[2]);
      const etag = `"m-${previewId}-${rev}"`;
      const ifNoneMatch = getHeader(req, 'if-none-match');
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.statusCode = 304;
        res.setHeader('etag', etag);
        res.setHeader('cache-control', 'private, no-cache');
        res.setHeader('x-content-type-options', 'nosniff');
        res.end();
        return;
      }
      res.setHeader('etag', etag);
      res.setHeader('cache-control', 'private, no-cache');
      res.setHeader('x-content-type-options', 'nosniff');
      // manifest 内部字段已是 snake_case，无需再转换。
      return writeJson(res, 200, manifest);
    }

    // GET /previews/{id}/revisions/{rev}/artifacts/{artifactId}
    const artifactMatch =
      /^\/previews\/([^/]+)\/revisions\/(\d+)\/artifacts\/([^/]+)$/.exec(
        subPath,
      );
    if (method === 'GET' && artifactMatch) {
      const rangeHeader = req.headers.range;
      const range = rangeHeader ? parseRangeHeader(rangeHeader) : undefined;
      const result = await options.host.getArtifact(ctx, {
        previewId: decodeURIComponent(artifactMatch[1]!),
        publishedRevision: Number(artifactMatch[2]),
        artifactId: decodeURIComponent(artifactMatch[3]!),
        ...(range ? { range } : {}),
      });
      res.statusCode = result.range ? 206 : 200;
      res.setHeader('content-type', result.mediaType);
      res.setHeader('content-length', String(result.sizeBytes));
      res.setHeader('etag', `"${result.sha256}"`);
      res.setHeader('cache-control', 'private, no-cache');
      res.setHeader('x-content-type-options', 'nosniff');
      if (result.range) {
        res.setHeader(
          'content-range',
          `bytes ${result.range.start}-${result.range.endInclusive}/${result.totalSize}`,
        );
      }
      await pipeWebToNode(result.stream, res);
      return;
    }

    // POST /previews/{id}/revisions/{rev}/sheet-windows
    const sheetWinMatch =
      /^\/previews\/([^/]+)\/revisions\/(\d+)\/sheet-windows$/.exec(subPath);
    if (method === 'POST' && sheetWinMatch) {
      const previewId = decodeURIComponent(sheetWinMatch[1]!);
      const publishedRevision = Number(sheetWinMatch[2]);
      const manifest = await options.host.getManifest(ctx, { previewId, publishedRevision });

      const body = (await readJsonBody(req)) as Record<string, unknown> | null;
      const rangeObj = (body?.['range'] as Record<string, unknown> | undefined) ?? body ?? {};
      const targetSheetId = String(rangeObj['sheet_id'] ?? rangeObj['sheetId'] ?? 'sheet_1');
      const rowStart = Math.max(1, Number(rangeObj['row_start'] ?? rangeObj['rowStart'] ?? 1));
      const rowEnd = Math.max(rowStart, Number(rangeObj['row_end'] ?? rangeObj['rowEnd'] ?? (rowStart + 99)));
      const colStart = Math.max(1, Number(rangeObj['col_start'] ?? rangeObj['colStart'] ?? 1));
      const colEnd = Math.max(colStart, Number(rangeObj['col_end'] ?? rangeObj['colEnd'] ?? (colStart + 19)));

      const artifacts = (manifest['artifacts'] as Array<Record<string, unknown>>) ?? [];
      const entryArtifact = artifacts.find(
        (a) => a['role'] === 'entry' && String(a['path'] ?? '').endsWith('workbook.json'),
      );

      if (entryArtifact) {
        const entryRes = await options.host.getArtifact(ctx, {
          previewId,
          publishedRevision,
          artifactId: String(entryArtifact['artifact_id']),
        });
        const workbookBuf = await readWebStream(entryRes.stream);
        const workbook = JSON.parse(new TextDecoder('utf-8').decode(workbookBuf)) as {
          sheets?: Array<{
            sheet_id: string;
            row_count: number;
            col_count: number;
            merges?: string[];
            chunks?: Array<{
              row_start: number;
              row_end: number;
              col_start: number;
              col_end: number;
              artifact_id: string;
            }>;
          }>;
        };

        const targetSheet = (workbook.sheets ?? []).find((s) => s.sheet_id === targetSheetId);
        if (targetSheet) {
          const coveringChunks = (targetSheet.chunks ?? []).filter(
            (c) => c.row_start <= rowEnd && c.row_end >= rowStart,
          );

          const matchingCells: Array<Record<string, unknown>> = [];
          for (const chunk of coveringChunks) {
            const chunkRes = await options.host.getArtifact(ctx, {
              previewId,
              publishedRevision,
              artifactId: chunk.artifact_id,
            });
            const chunkBuf = await readWebStream(chunkRes.stream);
            const chunkData = JSON.parse(new TextDecoder('utf-8').decode(chunkBuf)) as {
              rows?: Array<Array<{ row: number; col: number; [key: string]: unknown }>>;
            };
            for (const row of chunkData.rows ?? []) {
              for (const cell of row) {
                if (
                  cell.row >= rowStart &&
                  cell.row <= rowEnd &&
                  cell.col >= colStart &&
                  cell.col <= colEnd
                ) {
                  matchingCells.push({
                    row: cell.row,
                    col: cell.col,
                    type: cell['type'] ?? 'string',
                    raw_value: String(cell['raw_value'] ?? ''),
                    display_value: String(cell['display_value'] ?? cell['raw_value'] ?? ''),
                  });
                }
              }
            }
          }

          return writeJson(res, 200, {
            sheet_id: targetSheetId,
            range: {
              published_revision: publishedRevision,
              sheet_id: targetSheetId,
              row_start: rowStart,
              row_end: rowEnd,
              col_start: colStart,
              col_end: colEnd,
            },
            cells: matchingCells,
            merges: targetSheet.merges ?? [],
            coverage: {
              unit: 'rows',
              shown: matchingCells.length,
              total: targetSheet.row_count,
              scope: targetSheetId,
            },
            warnings: [],
          });
        }
      }

      return writeJson(res, 200, {
        sheet_id: targetSheetId,
        range: {
          published_revision: publishedRevision,
          sheet_id: targetSheetId,
          row_start: rowStart,
          row_end: rowEnd,
          col_start: colStart,
          col_end: colEnd,
        },
        cells: [],
        merges: [],
        coverage: {
          unit: 'rows',
          shown: 0,
          total: 0,
          scope: targetSheetId,
        },
        warnings: [],
      });
    }

    throw HostErrors.resourceNotFound(`路由未匹配：${method} ${subPath}`);
  }
}

function normalizeBasePath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw HostErrors.protocolError('请求体不是合法 JSON');
  }
}

function parseRangeHeader(
  raw: string,
): { start: number; endInclusive: number } | undefined {
  const m = /^bytes=(\d+)-(\d*)$/.exec(raw.trim());
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER;
  return { start, endInclusive: end };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

function writeError(
  res: ServerResponse,
  requestId: string,
  err: unknown,
): void {
  const hostErr: HostPreviewError = isHostPreviewError(err)
    ? err
    : HostErrors.unknown(err);
  writeJson(
    res,
    hostErr.httpStatus,
    encodeError(requestId, hostErr.toPayload()),
  );
}

async function pipeWebToNode(
  web: ReadableStream<Uint8Array>,
  res: ServerResponse,
): Promise<void> {
  const reader = web.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!res.write(value)) {
          await new Promise<void>((resolve) =>
            res.once('drain', () => resolve()),
          );
        }
      }
    }
    res.end();
  } catch (err) {
    res.destroy(err as Error);
  }
}

async function readWebStream(
  web: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = web.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.length;
    }
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
