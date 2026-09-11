export const HTTP_PROTOCOL_VERSION = '1.0' as const;

export const MANIFEST_SCHEMA_VERSION = '1.0' as const;
export const PREVIEW_STATE_SCHEMA_VERSION = '1.0' as const;
export const SHEET_WINDOW_SCHEMA_VERSION = '1.0' as const;

export const CONVERTER_INPUT_CONTRACT_VERSION = '1.0' as const;

export const SCHEMA_IDS = {
  previewState: 'https://unipat.dev/file-preview/schemas/preview-state.v1.json',
  manifest: 'https://unipat.dev/file-preview/schemas/manifest.v1.json',
  sheetWindow: 'https://unipat.dev/file-preview/schemas/sheet-window.v1.json',
} as const;

export const SCHEMA_FILE_PATHS = {
  previewState: '../schemas/preview-state.schema.json',
  manifest: '../schemas/manifest.schema.json',
  sheetWindow: '../schemas/sheet-window.schema.json',
} as const;

export const DEFAULT_HTTP_BASE_PATH = '/api/file-preview/v1' as const;

export const DEFAULT_PROFILE_ID = 'standard-v1' as const;

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key' as const;

export const IDEMPOTENCY_KEY_MIN_LENGTH = 16 as const;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128 as const;

export const RESOURCE_KEY_MAX_LENGTH = 256 as const;
export const SOURCE_VERSION_MAX_LENGTH = 128 as const;
export const NAMESPACE_MAX_LENGTH = 64 as const;
export const TENANT_ID_MAX_LENGTH = 128 as const;

export const SHEET_WINDOW_MAX_ROWS = 200 as const;
export const SHEET_WINDOW_MAX_COLS = 100 as const;
export const SHEET_WINDOW_MAX_BYTES = 32 * 1024 * 1024;

export const CLIENT_MAX_PARALLEL_REQUESTS = 4 as const;

export const CLIENT_POLL_MIN_INTERVAL_MS = 2000 as const;
export const CLIENT_POLL_MAX_INTERVAL_MS = 10000 as const;
