import type React from 'react';

export type FileSource = string | File | Blob;

export interface PreviewPluginProps {
  src: FileSource;
  fileType: string;
  fileName?: string | undefined;
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
  onLoad?: (() => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
}

export interface PreviewPlugin {
  name: string;
  match: (fileType: string, src: FileSource) => boolean;
  Component: React.ComponentType<PreviewPluginProps>;
}
