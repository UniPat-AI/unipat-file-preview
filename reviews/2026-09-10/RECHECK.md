# 第二轮复查：修复了一批局部问题，仍建议 REQUEST_CHANGES

日期：2026-09-10。对象：当前 `/Users/gelx/Desktop/code/unipat-file-preview` 文件快照。本地仍没有 Git 元数据，无法确认提交范围或远端是否还有更新。未修改实现；执行构建刷新了 dist，新增复查记录和合成数据验证脚本。

## 结论与边界

这次确实有实质修复，尤其是现有 host 的权限/清理回归、HTML/GBK、manifest 错误态。但仍不能认定“真实文件转换后能正确预览”。主要遗漏集中在跨层协议及组件行为，新增测试没有覆盖这些路径。

**公共包不负责 MySQL、OSS 生产存储、数据库迁移、持久化任务调度、租约恢复和业务保留/清理策略。** 缺少这些实现不算缺陷；后续应收窄公开入口和交付文档，而不是继续补后台平台。本文涉及现有 Node host 的问题用于说明当前发布/示例链路不可用，并不要求公共包继续拥有 host。

## 已确认的修复

- Node 新增回归测试验证了跨租户按 ID 查询拒绝、源失效后阻止读取、只读 state 不创建 job、clear 后旧任务发布被拒绝、过期 heartbeat 被拒绝、简单 partial 结果发布、过期索引清理、manifest 私有缓存和 Range 裁剪。Node 单测 16/16 通过。这里仅认可测试实际覆盖的场景，未将整项生命周期安全宣告完成。
- HTML void 标签之后的尾文本不再丢失；GBK 中文样本正常解码。
- PDF 解析异常不再被吞掉；合法 PDF 超输出预算样本正确返回 OUTPUT_TOO_LARGE。
- XLSX 产物已有 merges、freeze、hidden_columns 元数据，简单百分比从 0.25 改成了 25%；完整显示语义仍未实现，见下文。
- React 已增加真实 retry 调用及 representation 别名分发；Gallery 排除 thumbnail 角色；HTML 使用受 sandbox 限制的 srcDoc。
- **浏览器确认** manifest 返回 ACTION_FORBIDDEN 时显示授权错误，原来一直 loading 的问题已修复。

## 仍需处理的问题

### C01 · P1：公共发布入口与交付清单仍然承担后台平台职责

位置：[index.ts:17](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/index.ts:17)、[PROGRESS.md:80](/Users/gelx/Desktop/code/unipat-file-preview/PROGRESS.md:80)、[PROGRESS.md:102](/Users/gelx/Desktop/code/unipat-file-preview/PROGRESS.md:102)。

公共入口仍导出 Orchestrator、Store、JobRow、租约及清理相关类型；进度文档仍把真实 DB/OSS/K8s Runner、MySQL 建表迁移列为待交付功能。这与最新确认的包边界不一致，也会继续误导同事的任务范围。将这些职责移到接入项目或明确的外部示例，公共包保留转换、产物协议、查看器和最小读取/调用适配；同步重写方案和进度清单。**不要以补 MySQL 或生产 Port 的方式关闭此项。**

### C02 · P1：artifact ID 重映射仍然切断正文分块引用

位置：[orchestrator.ts:306](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:306)、[orchestrator.ts:344](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:344)、[viewers.tsx:40](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/viewers.tsx:40)。

发布时为每个 artifact 重新生成 UUID，未保留 converter ID 对照，也未更新 text/index.json 的 chunk_ids 和 workbook 的 chunk.artifact_id。入口匹配新增的 role=entry 兜底只能碰巧选中第一个入口，不能解决产物内部引用。用真实 Python TXT/CSV/XLSX 产物接入当前 Orchestrator，三类分块读取都返回 RESOURCE_NOT_FOUND/404。

此外 TextViewer 把 JSON 解析和所有 chunk 请求包在同一个 catch 中，分块 404 被当作“不是索引 JSON”。**浏览器确认**页面直接显示 `{"chunk_ids":["chunk_0000"]}`，没有正文或错误提示。

应在公共产物协议中明确稳定逻辑 ID 与物理存储定位的关系；读取适配必须能解析逻辑引用，或完整重写引用后重新计算摘要。TextViewer 只对解析失败做原文回退，请求失败应显式报错。这不依赖数据库或生产存储实现。

### C03 · P1：新增表格读取逻辑对正常发布结果仍返回“成功的空表”

位置：[http.ts:358](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/http.ts:358)、[http.ts:400](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/http.ts:400)、[csv_processor.py:56](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/csv_processor.py:56)。

接口通过 artifact.path 末尾 workbook.json 找入口，但 Orchestrator 的发布描述符不含 path。因此正常产物走到 200 空 cells、coverage=0、warnings=[] 的兜底。**真实转换产物复现：CSV 与 XLSX 都如此。** 即使单独修入口和 ID，CSV 产物用 cells 字符串二维数组，接口只读取 rows 单元格对象数组，仍不兼容。

按 representation.entry_artifact_id 读取入口，统一 CSV/XLSX 的分块协议；入口缺失或格式错误必须报错，不能伪装成功空表。若把此 HTTP 实现移出公共包，外部示例也应先通过此验收。

### C04 · P1：client 切换仍沿用旧身份的 previewId

位置：[use-preview.ts:92](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/hooks/use-preview.ts:92)、[use-preview.ts:136](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/hooks/use-preview.ts:136)、[file-preview.tsx:22](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/file-preview.tsx:22)。

新增 client 只在 useMemo 依赖中，返回的 key 字符串不含 client；当文件/version/profile 不变时，client 换了而 key 值不变，依赖 [key] 的 bootstrap 不重跑。FilePreviewProps 也未暴露新增 identityKey。

**浏览器复现调用序列：** `A getState → A fetchManifest A → 切换 B → B fetchManifest A`，没有 `B getState`。这证明新身份继续使用旧预览标识；不能据此宣称生产服务必然泄漏，因为服务端可能正确拒绝，但前端隔离仍有缺陷。应把 client/identity 的变更直接纳入生命周期，公开 identityKey，清空旧内容并防止旧异步结果回写。useSheetWindow 同样缺少 client 依赖。

### C05 · P1：Excel 公式缓存和格式显示仍不正确

位置：[spreadsheet.py:66](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/spreadsheet.py:66)、[spreadsheet.py:150](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/spreadsheet.py:150)。

使用带已保存公式缓存的合成 XLSX 验证结果：

| 原始值/格式 | 应显示 | 当前 display_value |
|---|---|---|
| 0.25，0.00% | 25.00% | 25% |
| 1234.5，#,##0.00 | 1,234.50 | 1234.5 |
| 123，000000 | 000123 | 123 |
| =1+1，已保存缓存 2 | 2 | =1+1 |

仅检查格式字符串中是否含 %，并固定两位后去零，无法替代数字格式处理。应读取保存的公式结果并保留公式元信息，按格式生成 display_value；缺少缓存时明确提示，不把公式表达式冒充计算结果。不要求公共包重算任意 Excel 公式。

### C06 · P1：隐藏工作表的默认选择仍然错误，元数据尚未贯通显示

位置：[table-viewer.tsx:50](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/table-viewer.tsx:50)、[table-viewer.tsx:144](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/table-viewer.tsx:144)。

转换器输出 very_hidden，查看器只排除 hidden，所以第一个 veryHidden 工作表会被当作默认可见表；页签还遍历全部 sheets，普通隐藏表也会展示。合成样本第一张是 Internal/veryHidden，实际活动页为 Business，产物与选择条件能直接确认此问题。此次未对表格显示做浏览器重测，因为真实窗口读取已被 C03 阻断。

此外新增导出的 hidden_columns 没有对应消费，merges/freeze 也未用于网格显示。应默认仅展示 visible 工作表、使用明确的默认页信息，并将元数据接入查看器。隐藏状态属于文档展示语义，本项不将它当作权限边界。

### C07 · P2：Notebook 的普通输出仍被丢弃

位置：[notebook.py:102](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/notebook.py:102)、[notebook-viewer.tsx:277](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/notebook-viewer.tsx:277)。

转换器输出 text_plain、traceback_summary，查看器仍读原始 Notebook 的 data['text/plain']、traceback。**浏览器直接喂入真实转换产物：** `1+1` 的输出 `2` 显示为 `[unsupported output: (empty)]`。应统一清洗后的 Notebook 输出结构，让转换器与查看器共享样本验收。

### C08 · P2：partial 发布已修，但用户仍看不到缺失提示

位置：[file-preview.tsx:87](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/file-preview.tsx:87)。

FilePreview 对 ready/partial 最终都直接返回 ViewerDispatch，没有展示 state/manifest/representation 的 warnings、coverage 或完整性。截断文件仍呈现为普通完整预览。应在公共组件提供明确的部分内容提示，告知缺失范围和原因。后端已有 partial 单测不能关闭前端展示问题。

### C09 · P2：PDF 校验修复引入加密文件误判

位置：[pdf.py:63](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/pdf.py:63)。

先访问 reader.pages 再检查 is_encrypted。需要密码的有效 PDF 在读取 pages 时抛异常，被统一改成 INVALID_CONVERSION_OUTPUT。**用 pypdf 生成的有效加密 PDF 已复现：**返回“File has not been decrypted”，未走 PASSWORD_REQUIRED。先判断加密，再读页数；测试同时覆盖有效、损坏、加密、超预算四类。

## 未因本次修改关闭的原审查项

- R12：PDF 复制预算这一路已修；Node 仍整段累积源字节，读取 candidate.relativePath 前没有独立的路径/摘要复核。移出 host 后不把这些变成公共库后台建设要求。转换器单次处理的资源约束仍属公共能力。XLSX 改成 read_only=False 后，会在行数/单元格预算判断前加载整个工作簿，需要补大文件内存边界验证；本轮没有压测或复现 OOM。
- R14：DICOM 仍按 ndim 判断帧并统一 mode=L，彩色/像素变换问题未改。本机缺 pydicom，本轮仅复核源码，未重跑 DICOM 样本。
- R15：PDF 查看器仍遍历全页创建 canvas，未改为可见页渲染。本轮未做大 PDF 浏览器负载测试。
- R22：installFilePreview 仍向已有 server 添加第二个 request listener，旧集成冲突未解决；可随 host 移出公开入口处理。
- 示例仍将 `/v1` 代理到 host，而客户端使用 `/api/file-preview/v1`。本轮打开原 demo 仍显示 UNKNOWN_ERROR/Not Found。浏览器组件隔离验证使用临时代理纠正路径，不计为原 demo 已跑通。

## 验证记录与限制

| 检查 | 本轮结果 |
|---|---|
| pnpm run build | 通过 |
| pnpm run typecheck | 通过 |
| pnpm run test | 失败：core 52/53；longpoll URL 测试拿到 undefined |
| Node 单独测试 | 16/16 通过 |
| React 单独测试 | 2/2 通过 |
| Python unittest | 17/17 通过 |
| 真实 converter → 当前发布逻辑 | TXT/CSV/XLSX 分块均 404，CSV/XLSX 窗口为空 |
| 浏览器隔离测试 | 身份切换仍错；manifest 错误态已修；Notebook 输出丢失；text 分块异常被吞 |

core 失败的测试只等待若干 setImmediate，而请求通过定时器调度；结果可能与事件循环时序有关，因此不直接判定生产 URL 拼接故障。但当前统一测试入口确实没有通过。

React 两条测试分别验证导出存在和 core 客户端 retry HTTP 请求，没有挂载组件；它们不能验证身份切换、错误分支或真实格式渲染。建议补 converter 真实产物到消费端的契约测试及组件行为测试，优先验证上述失败样本，不继续增加只覆盖 EchoRunner 的成功测试。

复现文件见 [recheck 产物结果](./recheck/real-converter-results.txt)、[转换器细节](./recheck/converter-details.txt)、[全量测试日志](./recheck/test-all.log)、[fixture 生成脚本](./recheck/generate-fixtures.py)、[发布链路脚本](./recheck/probe-real-converter.mjs)、[浏览器 harness](./recheck/browser-harness.html)。发布链路脚本仅转换 Runner 顶层字段命名并拷贝真实产物，未重写内部 ID 或正文；它验证当前各层接口的兼容性，不声称仓库已有正式 Python Runner 适配器。

本轮没有验证 Docker/LibreOffice 全链路、真实生产接入、React 19、大文档负载；没有操作生产业务数据。
