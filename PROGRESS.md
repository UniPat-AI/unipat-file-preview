# 执行进度

本文件是**唯一的进度视图**，按 5 份设计文档 + `supported-formats.json` 拆解交付项，随每次开工同步更新。

图例：`[x]` 已完成 · `[~]` 进行中 · `[ ]` 未开始 · `⚠️` 存在待澄清 / 阻塞项

---

## 0. 骨架与仓库基础设施

- [x] 根 `package.json`、`pnpm-workspace.yaml`（含 `examples/*`）、`.npmrc`、`.gitignore`、`tsconfig.base.json`
- [x] `packages/core`、`packages/react`、`packages/node`、`host-go`、`converter`、`database/mysql` 目录与最小 README 占位
- [x] `examples/node-inmemory` 端到端示例目录
- [x] 根 `README.md` 指向 `docs/` 与本文档
- [ ] 根 CI 脚本（lint、typecheck、build 聚合）
- [ ] Changesets 或等价发版工具
- [x] `pnpm install` + `pnpm -r run typecheck` 在本机跑通（contracts + core + node）

## 1. 契约层 `contracts/`

对应文档：`docs/01`、`docs/02`、`docs/04`、`supported-formats.json`

- [x] 错误码枚举 `ERROR_CODES` + `ErrorCode` / `PreviewErrorPayload`
- [x] 支持格式清单 `SUPPORTED_FORMATS`（28 种扩展名，group / processor / primaryViewer 完备）
- [x] `FileRef` / `PreviewState` / `Manifest` / `SheetRange` / `SheetWindow` / `SheetCell` 类型
- [x] `Authorize` 接口与 `Principal`、`AccessDecision`
- [x] `HTTP_PROTOCOL_VERSION`、`MANIFEST_SCHEMA_VERSION`、`CONVERTER_INPUT_CONTRACT_VERSION`、幂等键长度、切片上限等常量
- [x] JSON Schema 版本仓（Manifest、State、SheetWindow 的机器可校验 schema，位于 `contracts/schemas/*.schema.json`，通过 `SCHEMA_IDS` / `SCHEMA_FILE_PATHS` 导出）
- [x] 行为样本（golden files，`contracts/golden/*.json`）与零依赖校验脚本 `tools/verify-golden.mjs`（`pnpm --filter @unipat/file-preview-contracts verify:golden`）
- [ ] Go 侧结构体镜像（`host-go` 消费用）

## 2. 前端核心 `packages/core`

对应文档：`docs/01`、`docs/02`、`docs/05`

- [x] 包配置（ESM、`sideEffects:false`、composite tsconfig）
- [x] 从 contracts 再导出所有协议类型与常量
- [x] `PreviewError` / `normalizePreviewError`（覆盖 AbortError、未知异常、服务端 `{error:{...}}` 与顶层 `{code,message,retryable,details}` 两种形态）
- [x] `deepSnakeToCamel` / `deepCamelToSnake`（浅识别 plain object，不误伤 class 实例）
- [x] `decodePreviewState` / `decodeManifest` / `decodeSheetWindow` + Manifest 主版本校验
- [x] `RequestQueue`（默认 4 并发上限，排队期支持 AbortSignal 取消；新增可选 `priority` 与 `perKeyMaxParallel` per-key 并发限流，向后兼容旧签名）
- [x] `buildResultCacheKey` / `buildSheetWindowCacheKey` / `buildStateCacheKey`
- [x] `createHttpPreviewClient`：state / generate / cancel / clear / fetchManifest / fetchArtifact / fetchSheetWindow，注入 `Idempotency-Key` 与 `x-preview-protocol`
- [x] 事件订阅（SSE）适配器：`subscribePreviewEvents`（fetch + ReadableStream 手工解析、Last-Event-ID 续传、指数退避重连）
- [x] LongPoll 兜底订阅：`subscribePreviewEventsLongPoll`（`/state` 轮询 + 状态变化时打包成 `preview-state` 事件；稳态自动放慢、支持 `retryAfterMs`；SSE 不可用环境下无缝退化）
- [x] Artifact 内存缓存：`createArtifactCache`（LRU + `maxBytes` 双约束 + `ETag` / `Cache-Control` 语义 + `parseMaxAgeMs` / `isFresh`）；`createHttpPreviewClient` 透传 `If-None-Match`、正确处理 `304 Not Modified`（复用旧数据并刷新 `storedAt`）
- [ ] 静态资源版本探测与 `STATIC_ASSET_VERSION_MISMATCH` 提示
- [x] 单元测试（`node --test`，53 pass：normalizePreviewError / deep(Snake|Camel)ToCamel / RequestQueue（含优先级 / per-key 限流 / 旧签名兼容）/ buildResultCacheKey / SSE 分包与重连 / LongPoll 状态适配 / http-client case-mapping / 二进制 artifact / artifactCache LRU + 304 协商 等）；浏览器 + Node 双环境 CI 待补

## 3. React 适配层 `packages/react`

对应文档：`docs/01`、`docs/03`

- [x] 目录 & README 占位
- [x] 包配置（ESM、`sideEffects:false`、composite tsconfig；依赖 core + peer react；build/typecheck/clean 脚本）
- [x] `usePreview`：`getState → autoGenerate → 轮询`，暴露 `phase / state / error / refresh / requestGenerate / cancel / clear`；支持通过 `events` 选项启用 SSE 优先 + 轮询兜底
- [x] `useManifest` / `useArtifact`：基于 AbortController 的资源拉取 hook，错误经 `normalizePreviewError` 归一
- [x] `<FilePreview>` 顶层组件：默认 Loading / Error / Empty 视图 + `renderLoading` / `renderError` / `renderEmpty` 覆盖钩子
- [x] Viewer 分发：内置 `TextViewer` / `PdfViewer`（pdf.js）/ `TableViewer` / `GalleryViewer` / `HtmlViewer`（sandbox iframe + Blob URL + F/Esc/R 快捷键）/ `NotebookViewer`（cell 结构渲染 + outputs + j/k/n/m 键位）；未知类型降级到 `UnsupportedViewer`
- [x] pdf.js / 真实 PdfViewer 接入（`pdfjs-dist` + worker 通过 `import.meta.url` 定位）
- [x] `useSheetWindow` hook 与 `TableViewer`（分页窗口按钮、错误信封展示；host 端 sheet-window endpoint 未实现时以 error UI 呈现）
- [x] `GalleryViewer`（多图缩放/切换 + 缩略图带 + object URL 生命周期）
- [ ] 静态资源加载策略（同域 iframe / CSP 白名单）
- [x] 键位与无障碍规范（PdfViewer +/-/0 缩放快捷键、TableViewer PageUp/PageDown/Alt+方向键翻页、GalleryViewer ←/→ 切图 + +/-/0 缩放；`role="region"/table/tab` + `aria-label` / `aria-rowcount` / `aria-live` + `tabIndex=0` 焦点管理）

## 4. Node 后端 `packages/node`

对应文档：`docs/01`、`docs/02`、`docs/04`、`docs/05`

- [x] 目录 & README 占位
- [x] 包配置（ESM、`sideEffects:false`、composite tsconfig；依赖 `@unipat/file-preview-contracts`；build/typecheck/clean 脚本）
- [x] 端口接口（5 个 Port）：`Authorize`、`SourceProvider`、`ArtifactStorage`、`Runner`、`Store` + `IdempotencyStore`
- [x] 端口内存桩：`allowAllAuthorize` / `InMemorySourceProvider` / `InMemoryArtifactStorage` / `InMemoryIdempotencyStore` / `InMemoryStore` / `EchoRunner`（仅够 e2e 跑通）
- [x] `Orchestrator`：Job 状态机 queued → fetching → inspecting → converting → validating → publishing，含租约心跳、失败重试、终态 publishResult
- [x] `createPreviewHost`：ensurePreview / getPreviewState / cancel / clear / getManifest / getArtifact，含 Authorize 校验、幂等键、内部字段脱敏
- [x] `createHttpHandler`：路由 `GET /state`、`POST /generate`、`POST /previews/{id}/cancel|clear`、`GET /previews/{id}/revisions/{rev}/manifest|artifacts/{artifactId}`，含 `x-preview-protocol` 校验、`x-request-id` 注入、错误信封、Range 支持、Web→Node 流回填
- [x] `installFilePreview(server, options)` 一键装配入口：组装 `Orchestrator + createPreviewHost + createHttpHandler`，可挂到已有 `http.Server` 上并暴露 `start()/stop()`；`autoStart` 默认开启
- [x] SSE 事件推送：`GET /previews/{id}/events`（Last-Event-ID 续传、最近 100 条环形缓冲、15s 心跳）+ `PreviewEventBus`（发布 / 订阅 / since）；`installFilePreview` 自动接入 orchestrator `onStateChanged`
- [ ] 静态资源代理 & 版本校验
- [ ] 真实生产 Port（DB / OSS / K8s Runner）实现

## 5. Go 后端 `host-go`

对应文档：`docs/01`、`docs/02`、`docs/04`

- [x] 目录 & README 占位
- [ ] 与 Node 端等价的 Options 装配
- [ ] contracts 生成脚本（`.ts` → `.go` 或手写镜像的一致性校验）
- [ ] 与 converter / storage / database 的适配层

## 6. 转换容器 `converter`

对应文档：`docs/03`、`docs/04`

- [x] 目录 & README 占位
- [x] LibreOffice 基础镜像 + Python 服务（`Dockerfile` 基于 `python:3.11-slim-bookworm`，附加 LibreOffice / Noto CJK / Pillow / openpyxl / pydicom / defusedxml / pypdf；`USER converter` uid 10001 非 root；`HEALTHCHECK` 直连 `/healthz`；默认 `CMD` 启动 HTTP 服务）
- [x] `/convert`、`/healthz`、`/metrics` HTTP 接口（`http.server` 版 `converter.server`，支持子进程隔离 + `wall_time_seconds` 硬超时 + 一次性 `output_dir` 分配；`/metrics` 输出 `converter_requests_total/ok/failed/timeout` + `convert_seconds_sum` Prometheus 文本；CLI 入口 `python -m converter --request ...`）
- [x] 各 processor（pdf、office_pdf、spreadsheet、csv、image、dicom、html、structured_text、notebook、plain_text）：`processors/` 下 10 个统一 `(ctx) -> Manifest` 处理器；纯标准库路径覆盖 txt/md/json/xml/xbrl/csv/ipynb/html/pdf；office_pdf 走 LibreOffice headless；spreadsheet 走 openpyxl/xlrd；image 走 Pillow 多帧；dicom 走 pydicom 窗宽窗位
- [x] Sandbox / 资源限额 / 超时行为（`SandboxFs` 拒绝 `..` / 绝对路径 / 软链接、原子改名、字节预算实时累计；`TimeBudget` monotonic 时钟；子进程 `SIGTERM → SIGKILL`；HTML 输出附 CSP `default-src 'none'`）
- [x] 幂等输出布局与 SHA256（每个 artifact 由 `SandboxFs` 计算 SHA-256 与 size 后回填清单；runtime `_validate_manifest_paths` 二次复核每个 artifact 的实际 SHA-256 与 size；`ConvertResult` 落盘 `output_dir/result.json`；单测 17 case 全绿：processors × sandbox × HTTP 端到端）

## 7. 数据模型 `database/mysql`

对应文档：`docs/04`

- [x] 目录 & README 占位
- [ ] 建表 SQL：previews、preview_revisions、preview_jobs、idempotency_keys、artifact_index、audit_log
- [ ] 迁移工具与初始 seed
- [ ] 与 Node/Go 后端的 DTO 映射

## 8. 文档与验证

- [x] `docs/README.md`、5 份设计文档、`supported-formats.json` 保持只读参考
- [x] `examples/node-inmemory`：`node ./run.mjs` 起本地 host，用 `core` 客户端跑通 `requestGenerate → 轮询 getState → fetchManifest → fetchArtifact` 全链路（e2e 冒烟）
- [x] `examples/react-web`：`pnpm --filter @unipat/file-preview-example-react-web start` 起 host + vite（`/v1/*` 反代到 8787），浏览器里跑通 `<FilePreview>` 组件
- [ ] 根 `README.md` 逐步补充：架构图、快速上手、贡献指南
- [ ] 交付里程碑对齐文档 §5（`packages/core` v0.1、`packages/react` v0.1 …）

---

## 本次开工完成清单（速览）

- 建立 pnpm workspace 与 TypeScript composite 编译骨架
- 落地 `contracts/` 的错误码、支持格式、协议类型、schema 版本常量、JSON Schema + golden 样本 + 零依赖校验脚本
- 交付 `@unipat/file-preview-core` 的类型再导出、错误规范化、字段风格互转、协议解码、请求排队、缓存键、HTTP 客户端
- 交付 `@unipat/file-preview-node` 的 5 个 Port 接口 + 内存桩、Orchestrator 状态机、`createPreviewHost` 服务层与 `createHttpHandler` HTTP 层
- 交付 `@unipat/file-preview-react` 的 `usePreview` / `useManifest` / `useArtifact` / `useSheetWindow` hook、`<FilePreview>` 顶层组件与内置 Text / Pdf（pdf.js） / Table / Gallery / Unsupported viewer
- 新增 `examples/node-inmemory` 最小 e2e：Node 内置 http + core 客户端跑通 ensure → poll → manifest → artifact 全链路
- 新增 `examples/react-web`：host + vite dev server，浏览器里可直接渲染 `<FilePreview>`，通过 sample chips 覆盖 text / markdown / pdf / table / gallery 5 类样本（内置 `DemoRunner` 按扩展名分派 representation）
- 交付 `converter/`：`Dockerfile`（LibreOffice + Python 非 root）+ `pyproject.toml` + 10 个处理器（pdf/office_pdf/spreadsheet/csv/image/dicom/html/structured_text/notebook/plain_text）+ `SandboxFs`（SHA-256/字节预算/原子改名）+ `TimeBudget`（monotonic 硬超时）+ HTTP 服务（`/convert` `/healthz` `/metrics`）+ CLI 入口（`python -m converter`）+ 17 项 unittest 全绿
- 为 host-go / database 建立空壳目录，避免后续新增包冲击目录结构

## 已知阻塞 / 待澄清

- 根级 CI 尚未搭建；补 CI 后即可自动化跑 `pnpm -r run typecheck` 与 `build`。
- `packages/node` 目前仅提供内存桩，尚缺真实 DB / OSS / Runner 适配。`installFilePreview` 一键装配已提供，并集成 SSE 事件推送（`PreviewEventBus` 内存实现）。`sheet-windows` HTTP 路由仍返回 `protocolError('sheet-windows 未实现')`，`TableViewer` 会以 error UI 展示这一状态，待后端补齐。
- `packages/react` 全部内置 viewer（text / pdf / table / gallery / html / notebook）已具备；静态资源加载策略（同域 iframe / CSP 白名单）待补；主要 viewer 的键位与无障碍已具规范。
- `converter/` 层已全部完成：Dockerfile、HTTP `/convert` `/healthz` `/metrics`、10 个处理器、SandboxFs + TimeBudget、单测 17 case 全绿；后续可视需要接入 Kubernetes Job / Argo Workflows 作为真实 Runner。
