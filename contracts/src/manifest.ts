import type { PreviewWarning } from './preview-state.js';

export type RepresentationKind =
  | 'pdf'
  | 'table'
  | 'gallery'
  | 'html'
  | 'text'
  | 'notebook';

export type RepresentationStatus = 'ready' | 'failed' | 'skipped';

export type Completeness = 'complete' | 'partial' | 'unknown';

export interface CoverageInfo {
  readonly unit: 'rows' | 'frames' | 'cells' | 'chars' | 'pages';
  readonly shown: number;
  readonly total: number | null;
  readonly scope?: string;
}

export interface RepresentationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface Representation {
  readonly id: string;
  readonly kind: RepresentationKind;
  readonly label: string;
  readonly status: RepresentationStatus;
  readonly completeness: Completeness;
  readonly affectsCompleteness: boolean;
  readonly entryArtifactId: string | null;
  readonly coverage: CoverageInfo | null;
  readonly warnings: readonly PreviewWarning[];
  readonly error: RepresentationError | null;
}

export interface ArtifactDescriptor {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly role: 'entry' | 'chunk' | 'thumbnail' | 'frame' | 'auxiliary';
}

export interface ManifestSourceInfo {
  readonly name: string;
  readonly extension: string;
  readonly sizeBytes: number;
}

export interface ManifestCapabilities {
  readonly searchScope: 'none' | 'current_window' | 'current_sheet' | 'document';
  readonly staticOnly: boolean;
  readonly hasTextLayer?: boolean;
}

export interface Manifest {
  readonly schemaVersion: string;
  readonly previewId: string;
  readonly sourceId: string;
  readonly profileId: string;
  readonly publishedRevision: number;
  readonly source: ManifestSourceInfo;
  readonly defaultRepresentationId: string;
  readonly availability: 'ready' | 'partial';
  readonly representations: readonly Representation[];
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly capabilities: ManifestCapabilities;
  readonly warnings: readonly PreviewWarning[];
}

export interface SheetRange {
  readonly publishedRevision: number;
  readonly sheetId: string;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

export interface SheetCell {
  readonly row: number;
  readonly col: number;
  readonly type: 'string' | 'number' | 'boolean' | 'date' | 'error' | 'blank';
  readonly rawValue: string | null;
  readonly numberFormat: string | null;
  readonly displayValue: string | null;
  readonly formula: string | null;
  readonly cachedValue: string | null;
  readonly valueSource:
    | 'literal'
    | 'saved_formula_cache'
    | 'formula_without_cache'
    | 'unknown';
  readonly styleId: string | null;
  readonly warningCodes: readonly string[];
}

export interface SheetMerge {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

export interface SheetWindow {
  readonly sheetId: string;
  readonly range: SheetRange;
  readonly cells: readonly SheetCell[];
  readonly merges: readonly SheetMerge[];
  readonly coverage: CoverageInfo;
  readonly warnings: readonly PreviewWarning[];
}
