export type SupportedExtension =
  | 'pdf'
  | 'doc' | 'docx' | 'rtf'
  | 'ppt' | 'pptx'
  | 'xls' | 'xlsx' | 'xlsm'
  | 'csv'
  | 'png' | 'jpg' | 'jpeg' | 'bmp' | 'webp' | 'tif' | 'tiff'
  | 'dcm' | 'dicom'
  | 'html' | 'htm' | 'xhtml'
  | 'json' | 'xml' | 'xbrl'
  | 'ipynb'
  | 'txt' | 'md';

export type FormatGroup =
  | 'pdf'
  | 'office_document'
  | 'presentation'
  | 'spreadsheet'
  | 'csv'
  | 'image'
  | 'dicom'
  | 'html'
  | 'structured_text'
  | 'notebook'
  | 'plain_text';

export type ProcessorId =
  | 'pdf'
  | 'office_pdf'
  | 'spreadsheet'
  | 'csv'
  | 'image'
  | 'dicom'
  | 'html'
  | 'structured_text'
  | 'notebook'
  | 'plain_text';

export type ViewerId =
  | 'pdf'
  | 'table'
  | 'gallery'
  | 'html'
  | 'text'
  | 'notebook';

export interface SupportedFormat {
  readonly extension: SupportedExtension;
  readonly group: FormatGroup;
  readonly processor: ProcessorId;
  readonly primaryViewer: ViewerId;
}

export const SUPPORTED_FORMATS: readonly SupportedFormat[] = Object.freeze([
  { extension: 'pdf',   group: 'pdf',              processor: 'pdf',              primaryViewer: 'pdf' },
  { extension: 'doc',   group: 'office_document',  processor: 'office_pdf',       primaryViewer: 'pdf' },
  { extension: 'docx',  group: 'office_document',  processor: 'office_pdf',       primaryViewer: 'pdf' },
  { extension: 'rtf',   group: 'office_document',  processor: 'office_pdf',       primaryViewer: 'pdf' },
  { extension: 'ppt',   group: 'presentation',     processor: 'office_pdf',       primaryViewer: 'pdf' },
  { extension: 'pptx',  group: 'presentation',     processor: 'office_pdf',       primaryViewer: 'pdf' },
  { extension: 'xls',   group: 'spreadsheet',      processor: 'spreadsheet',      primaryViewer: 'table' },
  { extension: 'xlsx',  group: 'spreadsheet',      processor: 'spreadsheet',      primaryViewer: 'table' },
  { extension: 'xlsm',  group: 'spreadsheet',      processor: 'spreadsheet',      primaryViewer: 'table' },
  { extension: 'csv',   group: 'csv',              processor: 'csv',              primaryViewer: 'table' },
  { extension: 'png',   group: 'image',            processor: 'image',            primaryViewer: 'gallery' },
  { extension: 'jpg',   group: 'image',            processor: 'image',            primaryViewer: 'gallery' },
  { extension: 'jpeg',  group: 'image',            processor: 'image',            primaryViewer: 'gallery' },
  { extension: 'bmp',   group: 'image',            processor: 'image',            primaryViewer: 'gallery' },
  { extension: 'webp',  group: 'image',            processor: 'image',            primaryViewer: 'gallery' },
  { extension: 'tif',   group: 'image',            processor: 'image',            primaryViewer: 'gallery' },
  { extension: 'tiff',  group: 'image',            processor: 'image',            primaryViewer: 'gallery' },
  { extension: 'dcm',   group: 'dicom',            processor: 'dicom',            primaryViewer: 'gallery' },
  { extension: 'dicom', group: 'dicom',            processor: 'dicom',            primaryViewer: 'gallery' },
  { extension: 'html',  group: 'html',             processor: 'html',             primaryViewer: 'html' },
  { extension: 'htm',   group: 'html',             processor: 'html',             primaryViewer: 'html' },
  { extension: 'xhtml', group: 'html',             processor: 'html',             primaryViewer: 'html' },
  { extension: 'json',  group: 'structured_text',  processor: 'structured_text',  primaryViewer: 'text' },
  { extension: 'xml',   group: 'structured_text',  processor: 'structured_text',  primaryViewer: 'text' },
  { extension: 'xbrl',  group: 'structured_text',  processor: 'structured_text',  primaryViewer: 'text' },
  { extension: 'ipynb', group: 'notebook',         processor: 'notebook',         primaryViewer: 'notebook' },
  { extension: 'txt',   group: 'plain_text',       processor: 'plain_text',       primaryViewer: 'text' },
  { extension: 'md',    group: 'plain_text',       processor: 'plain_text',       primaryViewer: 'text' },
]);

const FORMAT_INDEX: ReadonlyMap<string, SupportedFormat> = new Map(
  SUPPORTED_FORMATS.map((f) => [f.extension, f]),
);

export function normalizeExtension(input: string): string {
  return input.trim().replace(/^\./, '').toLowerCase();
}

export function isSupportedExtension(input: string): input is SupportedExtension {
  return FORMAT_INDEX.has(normalizeExtension(input));
}

export function findFormat(input: string): SupportedFormat | undefined {
  return FORMAT_INDEX.get(normalizeExtension(input));
}
