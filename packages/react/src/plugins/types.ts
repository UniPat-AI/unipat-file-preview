import type { ArchiveLimits } from './archive.js';
import type React from 'react';

export type FileSource = string | File | Blob;

export interface PreviewPluginProps {
  src: FileSource;
  archiveLimits?: Partial<ArchiveLimits> | undefined;
  archiveDepth?: number | undefined;
  plugins?: readonly PreviewPlugin[] | undefined;
  disabledPlugins?: readonly string[] | undefined;
  fileType: string;
  fileName?: string | undefined;
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
  allowDownload?: boolean | undefined;
  allowOpen?: boolean | undefined;
  allowPrint?: boolean | undefined;
  onLoad?: (() => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
}

export interface PreviewPlugin {
  name: string;
  match: (fileType: string, src: FileSource) => boolean;
  Component: React.ComponentType<PreviewPluginProps>;
}
