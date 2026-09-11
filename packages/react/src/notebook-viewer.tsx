import { useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizePreviewError,
  PreviewError,
} from './contracts/index.js';
import type { ViewerContext } from './viewers.js';

interface NotebookCellBase {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
}
interface MarkdownCell extends NotebookCellBase {
  cell_type: 'markdown';
}
interface RawCell extends NotebookCellBase {
  cell_type: 'raw';
}
interface CodeCell extends NotebookCellBase {
  cell_type: 'code';
  execution_count?: number | null;
  outputs?: NotebookOutput[];
}
type NotebookCell = MarkdownCell | CodeCell | RawCell | NotebookCellBase;

interface StreamOutput {
  output_type: 'stream';
  name?: string;
  text?: string | string[];
}
interface DataOutput {
  output_type: 'display_data' | 'execute_result';
  data?: Record<string, string | string[]>;
  execution_count?: number | null;
}
interface ErrorOutput {
  output_type: 'error';
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
type NotebookOutput = StreamOutput | DataOutput | ErrorOutput;

interface NotebookDoc {
  nbformat?: number;
  nbformat_minor?: number;
  cells?: NotebookCell[];
}

function joinSource(source: string | string[] | undefined): string {
  if (!source) return '';
  return Array.isArray(source) ? source.join('') : source;
}

function isCodeCell(cell: NotebookCell): cell is CodeCell {
  return cell.cell_type === 'code';
}

export function NotebookViewer({
  client,
  previewId,
  publishedRevision,
  artifact,
}: ViewerContext) {
  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [err, setErr] = useState<PreviewError | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    const ac = new AbortController();
    setDoc(null);
    setErr(null);
    client
      .fetchArtifact({
        previewId,
        publishedRevision,
        artifactId: artifact.artifactId,
        signal: ac.signal,
      })
      .then((buf) => {
        if (ac.signal.aborted) return;
        try {
          const text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
          const parsed = JSON.parse(text) as NotebookDoc;
          setDoc(parsed);
        } catch (parseErr) {
          setErr(normalizePreviewError(parseErr));
        }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setErr(normalizePreviewError(e));
      });
    return () => ac.abort();
  }, [client, previewId, publishedRevision, artifact.artifactId]);

  const cells = useMemo<NotebookCell[]>(() => doc?.cells ?? [], [doc]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (!cells.length) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) {
        return;
      }
      let next = activeIndex;
      if (e.key === 'j' || e.key === 'J') next = activeIndex + 1;
      else if (e.key === 'k' || e.key === 'K') next = activeIndex - 1;
      else if (e.key === 'n' || e.key === 'N') {
        next = findNextByType(cells, activeIndex, 1);
      } else if (e.key === 'm' || e.key === 'M') {
        next = findNextByType(cells, activeIndex, -1);
      } else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = cells.length - 1;
      else return;
      e.preventDefault();
      next = Math.max(0, Math.min(cells.length - 1, next));
      setActiveIndex(next);
      const target = cellRefs.current[next];
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
        target.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [cells, activeIndex]);

  if (err) {
    return (
      <pre role='alert' style={styles.errorBox}>
        {err.code}: {err.message}
      </pre>
    );
  }

  if (!doc) {
    return <div style={styles.skeleton}>Loading notebook…</div>;
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role='region'
      aria-label='Jupyter Notebook 预览'
      style={styles.wrap}
    >
      <div style={styles.toolbar}>
        <span style={styles.hint}>
          按键：<kbd>J</kbd>/<kbd>K</kbd> 上下 · <kbd>N</kbd>/<kbd>M</kbd> 同类
          · <kbd>Home</kbd>/<kbd>End</kbd> 首尾
        </span>
        <span style={{ flex: 1 }} />
        <span style={styles.meta}>
          nbformat {doc.nbformat ?? '?'}·{cells.length} cells
        </span>
      </div>
      <ol style={styles.cellList} aria-label='Notebook cells'>
        {cells.map((cell, i) => (
          <li
            key={i}
            ref={(el) => {
              cellRefs.current[i] = el;
            }}
            tabIndex={-1}
            aria-current={i === activeIndex ? 'true' : undefined}
            aria-label={`Cell ${i + 1} (${cell.cell_type})`}
            style={{
              ...styles.cellItem,
              outline:
                i === activeIndex ? '2px solid #3182ce' : '1px solid #e2e8f0',
            }}
          >
            <CellView cell={cell} index={i} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function findNextByType(
  cells: readonly NotebookCell[],
  current: number,
  dir: 1 | -1,
): number {
  const type = cells[current]?.cell_type;
  if (!type) return current;
  for (let i = current + dir; i >= 0 && i < cells.length; i += dir) {
    if (cells[i]!.cell_type === type) return i;
  }
  return current;
}

function CellView({ cell, index }: { cell: NotebookCell; index: number }) {
  if (cell.cell_type === 'markdown') {
    return (
      <div>
        <div style={styles.cellBadge} aria-hidden>
          md #{index + 1}
        </div>
        <pre style={styles.mdBox}>{joinSource(cell.source)}</pre>
      </div>
    );
  }
  if (cell.cell_type === 'raw') {
    return (
      <div>
        <div style={styles.cellBadge} aria-hidden>
          raw #{index + 1}
        </div>
        <pre style={styles.rawBox}>{joinSource(cell.source)}</pre>
      </div>
    );
  }
  if (isCodeCell(cell)) {
    const outputs = cell.outputs ?? [];
    return (
      <div>
        <div style={styles.cellBadge} aria-hidden>
          code [{cell.execution_count ?? ' '}] #{index + 1}
        </div>
        <pre style={styles.codeBox}>{joinSource(cell.source)}</pre>
        {outputs.length > 0 ? (
          <ol style={styles.outputList} aria-label='Outputs'>
            {outputs.map((o, i) => (
              <li key={i} style={styles.outputItem}>
                <OutputView output={o} />
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    );
  }
  return (
    <div>
      <div style={styles.cellBadge} aria-hidden>
        {cell.cell_type} #{index + 1}
      </div>
      <pre style={styles.rawBox}>{joinSource(cell.source)}</pre>
    </div>
  );
}

function OutputView({ output }: { output: NotebookOutput }) {
  if (output.output_type === 'stream') {
    const text = Array.isArray(output.text)
      ? output.text.join('')
      : (output.text ?? '');
    return (
      <pre
        style={{
          ...styles.streamBox,
          color: output.name === 'stderr' ? '#c53030' : '#2d3748',
        }}
      >
        {text}
      </pre>
    );
  }
  if (output.output_type === 'error') {
    const traceback = (output.traceback ?? []).join('\n');
    return (
      <pre style={styles.errorTraceback} role='alert'>
        {output.ename}: {output.evalue}
        {traceback ? `\n${traceback}` : ''}
      </pre>
    );
  }
  const data = output.data ?? {};
  const png = data['image/png'];
  if (png) {
    const b64 = Array.isArray(png) ? png.join('') : png;
    return (
      <img
        alt='notebook output'
        src={`data:image/png;base64,${b64}`}
        style={styles.outputImg}
      />
    );
  }
  const plain = data['text/plain'];
  if (plain !== undefined) {
    const text = Array.isArray(plain) ? plain.join('') : plain;
    return <pre style={styles.streamBox}>{text}</pre>;
  }
  return (
    <pre style={styles.streamBox}>
      [unsupported output: {Object.keys(data).join(', ') || '(empty)'}]
    </pre>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    outline: 'none',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 6,
    borderBottom: '1px solid #e2e8f0',
    fontSize: 12,
    color: '#4a5568',
  },
  hint: { color: '#718096' },
  meta: { color: '#718096', fontFamily: 'monospace' },
  cellList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  cellItem: {
    borderRadius: 6,
    padding: 8,
    background: '#fff',
  },
  cellBadge: {
    display: 'inline-block',
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#4a5568',
    background: '#edf2f7',
    padding: '1px 6px',
    borderRadius: 3,
    marginBottom: 4,
  },
  mdBox: {
    margin: 0,
    padding: 8,
    background: '#f7fafc',
    borderRadius: 4,
    whiteSpace: 'pre-wrap',
    fontSize: 13,
    lineHeight: 1.5,
  },
  codeBox: {
    margin: 0,
    padding: 8,
    background: '#1a202c',
    color: '#e2e8f0',
    borderRadius: 4,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    overflow: 'auto',
  },
  rawBox: {
    margin: 0,
    padding: 8,
    background: '#f6f8fa',
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
  },
  outputList: {
    listStyle: 'none',
    padding: 0,
    marginTop: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  outputItem: {
    padding: 0,
  },
  streamBox: {
    margin: 0,
    padding: 6,
    background: '#edf2f7',
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
  },
  errorTraceback: {
    margin: 0,
    padding: 6,
    background: '#fff5f5',
    color: '#742a2a',
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
  },
  outputImg: {
    maxWidth: '100%',
    display: 'block',
    borderRadius: 4,
    background: '#fff',
  },
  errorBox: {
    padding: 12,
    background: '#fdecea',
    color: '#611a15',
    borderRadius: 6,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
  },
  skeleton: {
    padding: 12,
    color: '#666',
    fontStyle: 'italic',
  },
};
