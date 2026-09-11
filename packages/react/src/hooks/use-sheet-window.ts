import { useEffect, useMemo, useState } from 'react';
import type { SheetWindow } from '../contracts/index.js';
import {
  normalizePreviewError,
  PreviewError,
  type PreviewClient,
} from '../contracts/index.js';

export interface UseSheetWindowInput {
  readonly client: PreviewClient;
  readonly previewId: string;
  readonly publishedRevision: number;
  readonly sheetId: string;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

export interface UseSheetWindowResult {
  readonly window: SheetWindow | null;
  readonly loading: boolean;
  readonly error: PreviewError | null;
}

export function useSheetWindow(
  input: UseSheetWindowInput | null,
): UseSheetWindowResult {
  const [win, setWin] = useState<SheetWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PreviewError | null>(null);

  const key = useMemo(() => (input ? serialize(input) : null), [
    input?.previewId,
    input?.publishedRevision,
    input?.sheetId,
    input?.rowStart,
    input?.rowEnd,
    input?.colStart,
    input?.colEnd,
  ]);

  useEffect(() => {
    if (!input || !key) {
      setWin(null);
      setLoading(false);
      setError(null);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    input.client
      .fetchSheetWindow({
        previewId: input.previewId,
        range: {
          publishedRevision: input.publishedRevision,
          sheetId: input.sheetId,
          rowStart: input.rowStart,
          rowEnd: input.rowEnd,
          colStart: input.colStart,
          colEnd: input.colEnd,
        },
        signal: ac.signal,
      })
      .then((w) => {
        if (ac.signal.aborted) return;
        setWin(w);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(normalizePreviewError(err));
        setLoading(false);
      });
    return () => ac.abort();
  }, [key]);

  return { window: win, loading, error };
}

function serialize(input: UseSheetWindowInput): string {
  return [
    input.previewId,
    input.publishedRevision,
    input.sheetId,
    input.rowStart,
    input.rowEnd,
    input.colStart,
    input.colEnd,
  ].join('::');
}
