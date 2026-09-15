import React, { useEffect, useRef, useState } from 'react';
import { FilePreview } from '../file-preview.js';
import { archiveLimits, readArchiveSource, readGzip, readZip, readTar, readTarGzip, type ArchiveEntry } from './archive.js';
import { inferFileName } from './utils.js';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';

function ArchivePreview(props: PreviewPluginProps) {
  const { src, fileType, fileName, archiveDepth = 0 } = props;
  const name = inferFileName(src, fileName);
  const [state, setState] = useState<{ source: typeof src; entries?: ArchiveEntry[]; blob?: Blob; error?: string }>();
  const [selected, setSelected] = useState<{ path: string; blob: Blob }>();
  const [prefix, setPrefix] = useState('');
  const [memberError, setMemberError] = useState('');
  const [loadingMember, setLoadingMember] = useState(false);
  const active = useRef<AbortController>();
  const callbacks = useRef(props); callbacks.current = props;
  const limitsKey = JSON.stringify(props.archiveLimits ?? {});
  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(undefined); setSelected(undefined); setPrefix(''); setMemberError(''); setLoadingMember(false);
    active.current?.abort();
    void (async () => {
      try {
        const limits = archiveLimits(JSON.parse(limitsKey));
        if (archiveDepth >= limits.maxDepth) throw new Error('压缩文件嵌套层数超过预览限制');
        timer = setTimeout(() => ac.abort(new Error('读取压缩文件超时')), limits.timeoutMs);
        const data = await readArchiveSource(src, limits, ac.signal);
        const result = fileType === 'zip' ? { entries: readZip(data, limits) }
          : fileType === 'tar' ? { entries: readTar(data, limits) }
          : fileType === 'tgz' || fileType === 'tar.gz' || /\.tar\.gz$/i.test(name) ? { entries: await readTarGzip(data, limits, ac.signal) }
          : { blob: await readGzip(data, limits, ac.signal) };
        ac.signal.throwIfAborted();
        setState({ source: src, ...result });
        callbacks.current.onLoad?.();
      } catch (error) {
        if (ac.signal.aborted && ac.signal.reason?.name === 'AbortError') return;
        const err = error instanceof Error ? error : new Error(String(error));
        setState({ source: src, error: err.message }); callbacks.current.onError?.(err);
      } finally { clearTimeout(timer); }
    })();
    return () => { ac.abort(); clearTimeout(timer); active.current?.abort(); };
  }, [src, fileType, name, archiveDepth, limitsKey]);

  async function select(entry: ArchiveEntry) {
    active.current?.abort();
    const ac = new AbortController(); active.current = ac;
    const limits = archiveLimits(props.archiveLimits);
    const timer = setTimeout(() => ac.abort(new Error('解压文件超时')), limits.timeoutMs);
    setSelected(undefined); setMemberError(''); setLoadingMember(true);
    try {
      const blob = await entry.read(ac.signal);
      ac.signal.throwIfAborted();
      if (active.current === ac) setSelected({ path: entry.path, blob });
    } catch (error) {
      if (active.current === ac && ac.signal.reason?.name !== 'AbortError') {
        const err = error instanceof Error ? error : new Error(String(error));
        setMemberError(err.message); callbacks.current.onError?.(err);
      }
    } finally { clearTimeout(timer); if (active.current === ac) setLoadingMember(false); }
  }
  function child(blob: Blob, path: string) {
    return <FilePreview key={path} src={blob} fileName={path} archiveLimits={props.archiveLimits}
      archiveDepth={archiveDepth + 1} plugins={props.plugins} disabledPlugins={props.disabledPlugins}
      allowDownload={props.allowDownload} allowOpen={props.allowOpen} allowPrint={props.allowPrint}
      onError={props.onError} style={{ minHeight: 0, height: '100%', flex: 1 }} />;
  }
  const current = state?.source === src ? state : undefined;
  const directories = new Set<string>();
  const files = (current?.entries ?? []).filter(entry => {
    if (!entry.path.startsWith(prefix)) return false;
    const rest = entry.path.slice(prefix.length), slash = rest.indexOf('/');
    if (slash >= 0) { if (slash > 0) directories.add(rest.slice(0, slash)); return false; }
    return Boolean(rest) && !entry.directory;
  });
  return <section className={props.className} style={{ display: 'flex', flexDirection: 'column', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', ...props.style }} aria-label="压缩文件预览">
    <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>压缩文件内容 · {name}（只读）</div>
    {!current && <div role="status" style={{ padding: 16 }}>正在读取压缩文件…</div>}
    {current?.error && <div role="alert" style={{ padding: 16 }}>{current.error}</div>}
    {current?.blob && child(current.blob, name.replace(/\.gz$/i, ''))}
    {current?.entries && <>
      <nav aria-label="压缩包目录" style={{ padding: 12 }}>
        {prefix && <button type="button" onClick={() => setPrefix(prefix.replace(/[^/]+\/$/, ''))}>返回上一级</button>}
        <span style={{ marginLeft: 8 }}>{prefix || '/'} · {current.entries.filter(e => !e.directory).length} 个文件</span>
        <ul style={{ listStyle: 'none', padding: 0, maxHeight: 240, overflow: 'auto' }}>
          {[...directories].sort().map(dir => <li key={dir}><button type="button" onClick={() => setPrefix(`${prefix}${dir}/`)}>📁 {dir}/</button></li>)}
          {files.map(entry => <li key={entry.path}><button type="button" aria-pressed={selected?.path === entry.path} onClick={() => void select(entry)}>📄 {entry.path.slice(prefix.length)}</button> <small>{entry.size.toLocaleString()} 字节</small></li>)}
        </ul>
      </nav>
      {loadingMember && <p role="status">正在解压所选文件…</p>}
      {memberError && <p role="alert">{memberError}</p>}
      {selected ? <div><div style={{ padding: 12 }}>{selected.path}</div>{child(selected.blob, selected.path)}</div> : !loadingMember && !memberError && <p style={{ padding: 12 }}>请选择包内文件进行预览</p>}
    </>}
  </section>;
}
export const ArchivePlugin: PreviewPlugin = { name: 'archive', match: type => ['gz', 'zip', 'tar', 'tgz', 'tar.gz'].includes(type), Component: ArchivePreview };
