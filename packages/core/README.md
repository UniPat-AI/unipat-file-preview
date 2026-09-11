# @unipat/file-preview-core

公共文件预览库的核心包（框架无关）。当前版本落地了以下能力：

- 从 `contracts/` 再导出协议类型、错误码、格式清单和 schema 版本常量
- `PreviewError` / `normalizePreviewError`：把后端错误、AbortError、未知异常统一到 `PreviewError`
- `deepSnakeToCamel` / `deepCamelToSnake`：请求出入参的字段风格互转
- `decodePreviewState` / `decodeManifest` / `decodeSheetWindow`：协议解码 + 主版本校验
- `createHttpPreviewClient(...)`：状态、生成、取消、清理、清单、切片、表格窗口的 HTTP 客户端
- `RequestQueue`：默认 4 并发上限，支持 `AbortSignal` 排队期取消
- `buildResultCacheKey` / `buildSheetWindowCacheKey` / `buildStateCacheKey`：稳定缓存键

顶层导入不访问 `window` / `document` / `localStorage`，可在 Node 与浏览器同构使用。
