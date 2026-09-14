export { FilePreview } from './file-preview.js';
export type {
  FilePreviewProps,
  DirectFilePreviewProps,
  ServiceFilePreviewProps,
} from './file-preview.js';

// 插件化系统类型与默认插件
export type { PreviewPlugin, PreviewPluginProps, FileSource } from './plugins/types.js';
export {
  DEFAULT_PLUGINS,
  ArchivePlugin,
  PdfPlugin,
  ImagePlugin,
  JsonPlugin,
  TextPlugin,
  TablePlugin,
  MediaPlugin,
  HtmlPlugin,
  FallbackPlugin,
} from './plugins/default-plugins.js';
export { parseCsv } from './plugins/table-plugin.js';
export { inferFileType, inferFileName, useSourceUrl, useSourceText } from './plugins/utils.js';

// 微服务模式 hook 与查看器导出（兼容已有依赖）
export { usePreview, useManifest, useArtifact } from './hooks/use-preview.js';
export type {
  UsePreviewInput,
  UsePreviewResult,
  UseArtifactResult,
  PreviewPhase,
} from './hooks/use-preview.js';
export { useSheetWindow } from './hooks/use-sheet-window.js';
export type {
  UseSheetWindowInput,
  UseSheetWindowResult,
} from './hooks/use-sheet-window.js';
export { TextViewer, UnsupportedViewer } from './viewers.js';
export type { ViewerContext } from './viewers.js';
export { PdfViewer } from './pdf-viewer.js';
export { TableViewer } from './table-viewer.js';
export { GalleryViewer } from './gallery-viewer.js';
export { HtmlViewer } from './html-viewer.js';
export { NotebookViewer } from './notebook-viewer.js';

export { DEFAULT_ARCHIVE_LIMITS } from './plugins/archive.js';
export type { ArchiveLimits } from './plugins/archive.js';
