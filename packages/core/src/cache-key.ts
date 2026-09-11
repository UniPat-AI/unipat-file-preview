import type { FileRef } from './contracts.js';

export function buildResultCacheKey(input: {
  file: FileRef;
  profileId: string;
  publishedRevision: number;
  resourceHint: string;
}): string {
  return [
    'result',
    input.file.resourceKey,
    input.file.version,
    input.profileId,
    input.publishedRevision,
    input.resourceHint,
  ].join('|');
}

export function buildSheetWindowCacheKey(input: {
  previewId: string;
  publishedRevision: number;
  sheetId: string;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}): string {
  return [
    'sheet-window',
    input.previewId,
    input.publishedRevision,
    input.sheetId,
    input.rowStart,
    input.rowEnd,
    input.colStart,
    input.colEnd,
  ].join('|');
}

export function buildStateCacheKey(input: {
  previewId: string;
  generation: number;
  revision: number;
}): string {
  return [
    'state',
    input.previewId,
    input.generation,
    input.revision,
  ].join('|');
}
