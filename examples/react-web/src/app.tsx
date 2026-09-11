import { useMemo, useState } from 'react';
import { createHttpPreviewClient } from '@unipat/file-preview-core';
import { FilePreview } from '@unipat/file-preview-react';
import type { FileRef } from '@unipat/file-preview-contracts';

const SAMPLES: ReadonlyArray<{ label: string; file: FileRef }> = [
  { label: 'Text (hello.txt)', file: { resourceKey: 'files/hello.txt', version: 'v1' } },
  { label: 'Markdown (notes.md)', file: { resourceKey: 'files/notes.md', version: 'v1' } },
  { label: 'PDF (sample.pdf)', file: { resourceKey: 'files/sample.pdf', version: 'v1' } },
  { label: 'Table (sheet.xlsx)', file: { resourceKey: 'files/sheet.xlsx', version: 'v1' } },
  { label: 'Gallery (photo.png)', file: { resourceKey: 'files/photo.png', version: 'v1' } },
  { label: 'HTML (hello.html)', file: { resourceKey: 'files/hello.html', version: 'v1' } },
  { label: 'Notebook (demo.ipynb)', file: { resourceKey: 'files/demo.ipynb', version: 'v1' } },
];

const DEFAULT_FILE: FileRef = SAMPLES[0].file;

export function App() {
  const client = useMemo(
    () =>
      createHttpPreviewClient({
        baseUrl: window.location.origin,
      }),
    [],
  );

  const [resourceKey, setResourceKey] = useState(DEFAULT_FILE.resourceKey);
  const [version, setVersion] = useState(DEFAULT_FILE.version);
  const [file, setFile] = useState<FileRef>(DEFAULT_FILE);

  return (
    <div
      style={{
        maxWidth: 880,
        margin: '32px auto',
        padding: '0 16px',
        color: '#1a202c',
      }}
    >
      <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>
        @unipat/file-preview · react-web demo
      </h1>
      <p style={{ margin: '0 0 16px', color: '#4a5568', fontSize: 13 }}>
        走 <code>/v1/*</code> proxy 到当前进程内的 node host（内存桩）。
      </p>

      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        {SAMPLES.map((s) => {
          const active =
            s.file.resourceKey === file.resourceKey &&
            s.file.version === file.version;
          return (
            <button
              key={s.file.resourceKey}
              type="button"
              onClick={() => {
                setResourceKey(s.file.resourceKey);
                setVersion(s.file.version);
                setFile(s.file);
              }}
              style={{
                ...chipStyle,
                background: active ? '#3182ce' : '#fff',
                color: active ? '#fff' : '#2d3748',
                borderColor: active ? '#3182ce' : '#cbd5e0',
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setFile({ resourceKey, version });
        }}
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        <label>
          resource_key:{' '}
          <input
            value={resourceKey}
            onChange={(e) => setResourceKey(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label>
          version:{' '}
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            style={inputStyle}
          />
        </label>
        <button type="submit" style={buttonStyle}>
          Load
        </button>
      </form>

      <div
        style={{
          background: '#fff',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <FilePreview client={client} file={file} profileId="default" />
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: '1px solid #cbd5e0',
  borderRadius: 4,
  fontSize: 13,
  fontFamily: 'inherit',
  minWidth: 160,
};

const buttonStyle: React.CSSProperties = {
  padding: '4px 12px',
  border: '1px solid #3182ce',
  background: '#3182ce',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
};

const chipStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid',
  borderRadius: 999,
  cursor: 'pointer',
  fontSize: 12,
};
