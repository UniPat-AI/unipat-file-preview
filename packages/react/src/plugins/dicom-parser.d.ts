declare module 'dicom-parser' {
  export interface DicomElement {
    tag: string;
    vr?: string;
    length: number;
    dataOffset: number;
    items?: Array<{ dataSet: DataSet }>;
  }

  export interface DataSet {
    byteArray: Uint8Array;
    elements: Record<string, DicomElement>;
    warnings: string[];
    string(tag: string, index?: number): string | undefined;
    text(tag: string, index?: number): string | undefined;
    uint16(tag: string, index?: number): number | undefined;
    int16(tag: string, index?: number): number | undefined;
    uint32(tag: string, index?: number): number | undefined;
    int32(tag: string, index?: number): number | undefined;
    float(tag: string, index?: number): number | undefined;
    double(tag: string, index?: number): number | undefined;
    intString(tag: string, index?: number): number | undefined;
    floatString(tag: string, index?: number): number | undefined;
    attributeTag(tag: string): string | undefined;
  }

  export interface ParseDicomOptions {
    untilTag?: string;
    maxBytesToRead?: number;
    inflatedBuffer?: Uint8Array;
  }

  export function parseDicom(byteArray: Uint8Array, options?: ParseDicomOptions): DataSet;
  export function isStringVr(vr: string): boolean;
  export function isPrivateTag(tag: string): boolean;
}
