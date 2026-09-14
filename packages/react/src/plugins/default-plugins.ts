import { ArchivePlugin } from './archive-plugin.js';
import type { PreviewPlugin } from './types.js';
import { PdfPlugin } from './pdf-plugin.js';
import { ImagePlugin } from './image-plugin.js';
import { JsonPlugin } from './json-plugin.js';
import { TextPlugin } from './text-plugin.js';
import { TablePlugin } from './table-plugin.js';
import { MediaPlugin } from './media-plugin.js';
import { HtmlPlugin } from './html-plugin.js';
import { FallbackPlugin } from './fallback-plugin.js';

/**
 * 默认内置插件列表（按优先级降序排列）
 * JsonPlugin 优先于通用的 TextPlugin 匹配 .json
 */
export const DEFAULT_PLUGINS: readonly PreviewPlugin[] = [
  ArchivePlugin,
  PdfPlugin,
  ImagePlugin,
  JsonPlugin,
  TextPlugin,
  TablePlugin,
  MediaPlugin,
  HtmlPlugin,
  FallbackPlugin,
];

export {
  ArchivePlugin,
  PdfPlugin,
  ImagePlugin,
  JsonPlugin,
  TextPlugin,
  TablePlugin,
  MediaPlugin,
  HtmlPlugin,
  FallbackPlugin,
};
