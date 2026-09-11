import { useEffect, useRef, useState } from 'react';
import type { FileSource } from './types.js';

/**
 * 从 URL、文件名或 File 对象中提取并规范化扩展名（小写，不含点）
 */
export function inferFileType(src: FileSource, explicitType?: string, fileName?: string): string {
  if (explicitType) {
    return explicitType.trim().toLowerCase().replace(/^\./, '');
  }
  const candidateName = fileName || (typeof File !== 'undefined' && src instanceof File ? src.name : '');
  if (candidateName) {
    const m = candidateName.match(/\.([a-zA-Z0-9_-]+)(?:[?#].*)?$/);
    if (m?.[1]) return m[1].toLowerCase();
  }
  if (typeof src === 'string') {
    // 剔除 query 和 hash
    const cleanUrl = src.split(/[?#]/)[0] ?? '';
    const m = cleanUrl.match(/\.([a-zA-Z0-9_-]+)$/);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return '';
}

/**
 * 获取用于展示的文件名
 */
export function inferFileName(src: FileSource, fileName?: string): string {
  if (fileName) return fileName;
  if (typeof File !== 'undefined' && src instanceof File) return src.name;
  if (typeof src === 'string') {
    const cleanUrl = src.split(/[?#]/)[0] ?? '';
    const parts = cleanUrl.split('/');
    const last = parts[parts.length - 1];
    if (last) return decodeURIComponent(last);
  }
  return 'file';
}

/**
 * 将 FileSource 统一转换为可访问的 URL（如果是 Blob/File 则创建并自动 revoke object URL）
 */
export function useSourceUrl(src: FileSource): { url: string | null; error: Error | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let createdUrl: string | null = null;
    setError(null);
    try {
      if (typeof src === 'string') {
        setUrl(src);
      } else if (typeof Blob !== 'undefined' && src instanceof Blob) {
        createdUrl = URL.createObjectURL(src);
        setUrl(createdUrl);
      } else {
        throw new Error('不支持的文件源类型');
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }

    return () => {
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [src]);

  return { url, error };
}

/**
 * 读取文本数据
 */
export function useSourceText(src: FileSource): { text: string | null; loading: boolean; error: Error | null } {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const ac = new AbortController();
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        if (typeof src === 'string') {
          const resp = await fetch(src, { signal: ac.signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
          const data = await resp.text();
          if (!ac.signal.aborted && requestSeq.current === seq) setText(data);
        } else if (typeof Blob !== 'undefined' && src instanceof Blob) {
          const data = await src.text();
          if (!ac.signal.aborted && requestSeq.current === seq) setText(data);
        } else {
          throw new Error('不支持的文件来源');
        }
      } catch (err) {
        if (!ac.signal.aborted && requestSeq.current === seq) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!ac.signal.aborted && requestSeq.current === seq) setLoading(false);
      }
    }

    void load();
    return () => ac.abort();
  }, [src]);

  return { text, loading, error };
}
