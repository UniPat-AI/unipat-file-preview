# unipat-file-preview 全局代码审查

审查日期：2026-09-10。边界修订：依据用户本轮明确要求，公共包不实现数据库、生产存储、持久化任务调度和结果清理。结论：**REQUEST_CHANGES；主要阻塞为转换与渲染契约不一致、格式显示缺陷，以及公共包承担了过多业务基础设施职责。**

## 0. 修正后的公共包边界

用户最新要求优先于仓库原 v2.0 方案。此前把 MySQL、OSS/生产存储、任务租约与恢复列为公共包必须补齐的内容，是审查沿用了原方案中过重的边界，现撤回这些验收要求。

| 公共包负责 | 接入业务项目负责 |
|---|---|
| 文件类型识别、安全解析、无状态转换 | 原文件上传、业务文件引用与版本管理 |
| 统一产物/分块协议、完整性和错误信息 | 登录权限、租户归属、业务接口鉴权 |
| React 查看器与必要的读取回调/客户端适配 | 数据库表、连接、迁移和状态持久化 |
| 转换期间的临时资源释放、超时和输出限额 | 队列、调度、跨进程租约、重试与恢复 |
| 浏览器请求取消、组件缓存隔离、卸载释放 | 原文件和派生产物的存储、保留与清理策略 |

库可以定义最小输入输出接口并接收项目提供的读取函数；不能要求项目为使用查看器采用一套预览数据库表或库自带任务系统。转换工具仍需保证单次处理安全与资源受限；这与建设持久化后台平台是两件事。Node/Go 如需保留，应是协议类型、转换调用或框架适配的薄封装。

后文 R01–R06、R16、R17、R22 等保留为**当前已有 host 实现的风险证据**，供把该代码移入项目、替换或移出公共发布入口时参考；不代表公共包应新增这些能力。22 项原始发现不能再整体当作公共包必须实现的功能清单。

## 1. 范围与依据

- 读取了任务 `01a07ad4-9d6f-7ec2-8e08-4d0535350354` 的方案和后续讨论，以及本目录的五份 v2.0 设计文档、格式清单和 PROGRESS.md。
- 审查范围为当前工作目录全局实现，源码范围共 65 个 TS/TSX/Python 文件、11,348 行；重点追踪公开接口、生成与读取、权限、转换产物到查看器、取消与清理。此数字不包含文档、测试、dist 和依赖。
- 本地目录没有 `.git`，不能核对提交范围、作者或远端最新版本。本报告评价的是当前文件快照，不推断同事个人能力或工作量。
- 未修改实现代码。执行构建会刷新 dist；本目录只新增审查报告、合成样本复现脚本和结果。
- 使用合成数据测试，没有访问生产业务文件。文中的“已复现”与“源码确认”分别标注。

## 2. 完成度判断

| 模块 | 已有内容 | 按修正边界的判断 |
|---|---|---|
| contracts/core | TS 类型、schema/golden、HTTP 客户端、排队、缓存、SSE/轮询 | Python 和 TS 的实际协议未统一；运行时清单校验很弱；身份缓存边界未接入 |
| React | 统一组件、六类分发、基础查看器、取消读取、部分键盘操作 | 表格无真实数据链路；文本/HTML/Notebook/图片与转换器不匹配；缺少完整性提示；身份切换和错误态有缺陷 |
| Node host | Port 分层、HTTP handler、编排器、内存实现、事件总线 | 编排、持久化和清理职责应交回项目；现有实现有风险，不能直接作为生产接入示例 |
| converter | 28 扩展名路由、10 组处理器、输出摘要、部分路径检查、HTTP 子进程 | 格式语义和输出预算未验收；无法认定“全部完成”；还没有真实 host→converter→browser 集成 |
| Go | README | 只在需要 Go 薄接入封装时实现，不补一套后台管理系统 |
| MySQL | README | 不属于公共包职责；缺少 SQL/迁移不计作缺陷，移出交付范围 |
| 发布/测试 | 本地构建、单测、内存示例 | 需要 CI、发布流程、真实转换到浏览器样本、React 19 实际验收、资源发布清单；不要求公共包自建生产基础设施 |

合理的部分值得保留：core 不依赖 React；文件处理器独立；Office 使用参数数组和独立用户配置目录；React 多处释放请求和 Blob URL；内存实现明确标为测试桩。Port 抽象有助于识别边界，但仅把数据库/调度封装成接口，不能使这些职责自动成为公共包应承担的内容。

主要架构问题是：**各层分别做了接口和演示，却没有用同一份真实产物贯通验收。** DemoRunner 自己生成符合前端预期的数据，绕开真实转换器，导致单层测试通过也不能说明文件可以正常阅读。

## 3. 关键发现

### R01 · P1：按 ID 访问没有绑定 namespace 和 tenant

位置：[host.ts:82](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/host.ts:82)、[host.ts:313](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/host.ts:313)。

`loadPreviewOrFail` 仅按 ID 读取，没有核对记录的 namespace/tenantId 与当前可信上下文。后续 authorize 只收到 resourceKey/version；当不同租户使用相同业务编号时，回调可以正确放行当前租户自己的文件，但 host 返回的是另一租户 ID 指向的结果。state-by-id、manifest、artifact、cancel、clear 都有同类问题。

**已复现：** 使用仅允许 A/B 各自查看 `shared-key` 的权限回调，租户 B 提交 A 的 previewId 后成功读取 A 的 manifest。利用前提是获得另一租户 previewId；不需要回调主动允许跨租户访问。

修复：记录查询先校验/约束 namespace+tenant，跨租户统一 404，再调用业务权限。测试覆盖同名资源、跨 namespace、清单/产物/管理接口。

### R02 · P1：源失效与撤权不能完整阻止旧结果继续读取

位置：[host.ts:313](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/host.ts:313)、[orchestrator.ts:361](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:361)、[http.ts:218](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/http.ts:218)。

SourceProvider.isAvailable 虽定义在接口中，真实 host/编排器没有调用；读取不检查源状态，发布前也不复核源是否仍可用。长文件流和 SSE 仅建立时鉴权，之后没有设计要求的周期重检。SSE 回放还共享保存了包含用户 permissions 的初始 state。

**已复现：** isAvailable 改为始终 false 后，已发布清单仍可读取。若业务 authorize 自身也核对删除状态，能部分兜底，但库宣称的独立源有效性边界没有实现。

修复：统一所有读取路径的源有效性校验；实现源失效内部方法；发布前复核；长连接/长传输执行撤权检查并中止。SSE 共享事件不保存某个访问者的权限快照。

### R03 · P1：私有清单被声明为一年公共缓存

位置：[http.ts:283](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/http.ts:283)。

manifest 的 200/304 都返回 `public, max-age=31536000, immutable`。缓存可在后续请求到达应用鉴权之前直接返回私有清单；清理/撤权后浏览器仍可能使用缓存。文件名、产物 ID、状态本身也是业务数据。没有理由把私有动态清单当成公开静态资源。

**已复现：** HTTP 响应包含上述头。未搭建共享代理模拟数据泄漏。

修复：按方案返回 no-store；只有带版本的 Worker/字体等公开静态资源使用长期缓存。内容响应补齐 no-store/nosniff 等统一安全头。

### R04 · P1：GET 状态接口绕过 generate 权限创建任务

位置：[host.ts:229](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/host.ts:229)。

getPreviewState 只检查 view，却调用会创建 queued job 的 store.ensurePreview。只读查询、组件 autoGenerate=false、权限禁止生成均不能阻止转换产生。

**已复现：** authorize 只允许 view、拒绝 generate，GET 状态仍返回 queued，worker 可以领取并完成任务。

修复：拆开只读查状态与 ensure/enqueue；首次生成必须验证 view+generate；无记录的状态语义在协议中明确。

### R05 · P1：clear 后旧任务可以复活结果，发布版本还会重用

位置：[inmemory/store.ts:401](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/inmemory/store.ts:401)、[inmemory/store.ts:243](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/inmemory/store.ts:243)、[host.ts:279](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/host.ts:279)。

clearResults 清空指针但没有使现有 job/lease 失效；host.clear 不终止正在执行的任务。publishResult 只检查 lease token，不检查 generation/current_job_id/cleanup_state/lease expiry/source active。清理还把 publishedRevision 置 null，下一次发布重新从 1 开始，旧内容 URL 和 ETag 可能重用。

**已复现：** claim→clear→旧 job publish 后，预览由 cancelled 重新变为 succeeded。当前内存桩的 clear 也没有删除存储中的派生产物。

修复：事务内取消有效任务并标记固定清理目标；发布执行完整 fencing 条件；发布序号单调增长且不因清理重置；删除失败可重试。

### R06 · P1：租约只有阶段切换时续期，没有可靠失联恢复

位置：[orchestrator.ts:179](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:179)、[inmemory/store.ts:219](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/inmemory/store.ts:219)、[orchestrator.ts:101](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:101)。

默认租约 60 秒，但转换调用期间没有独立续租计时器。合法的长 Office 转换超过 60 秒时，严格 Store 应拒绝后续 heartbeat；现有内存 Store 却允许已经过期的 token 续租和发布。没有恢复扫描和重新领取过期 running job 的执行路径。stop 只停止主循环信号，没有中止 activeJobs 或调用 runner.cancel，会等待当前任务结束。

**已复现：** 1ms 租约过期后 heartbeat 仍返回 true。恢复扫描和 stop 行为由源码确认，未搭建多节点环境。

修复：独立周期续租、到期后不可续租、租约失效立即终止、事务恢复扫描、关闭时有界等待并中止运行器。把这些断言加入 Store 的共同行为测试。

### R07 · P1：真实转换器与 Node/React 协议不闭合

位置：[converter/contracts.py:17](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/contracts.py:17)、[orchestrator.ts:314](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:314)、[file-preview.tsx:107](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/file-preview.tsx:107)。

| 内容 | 转换器实际输出 | host/React 当前消费 |
|---|---|---|
| kind | plain_text / structured_text / image_gallery | text / gallery |
| 入口引用 | entry_artifact + 本地 id | entry_artifact_relative_path → entry_artifact_id |
| 文本 | text/index.json + chunk_ids | TextViewer 直接把入口当正文 |
| Notebook | text_plain / traceback_summary | data['text/plain'] / traceback |
| 图片 | 帧索引，另含 frame 和 thumbnail | 从全清单挑所有 image/*，缩略图也被当作独立页面 |
| HTML | text/plain 产物 | HtmlViewer 按相同 MIME 创建 Blob，显示 HTML 源码 |

此外 host 把源文件保存为 input.bin，openpyxl 按文件名后缀拒绝读取，即使请求 extension=xlsx。

**已复现：** TXT 输出为 plain_text+JSON 索引；同一有效 XLSX 使用 input.bin 路径运行时返回 InvalidFileException。其他字段冲突由源码逐项核对。当前没有生产 Runner，不能宣称已经出现线上集成失败，但按现有接口直接对接确实不成立。

修复：以同一套候选/公开清单 schema 约束 Python、Node、React；定义稳定的内部 artifact 引用映射，连索引内引用一起处理；以真实转换输出替换 DemoRunner 的验收依据。

### R08 · P1：表格接口伪装成功，前后端窗口和坐标也不匹配

位置：[http.ts:329](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/http.ts:329)、[http-client.ts:353](/Users/gelx/Desktop/code/unipat-file-preview/packages/core/src/http-client.ts:353)、[table-viewer.tsx:19](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/table-viewer.tsx:19)。

后端不读取任何数据块，永远返回 200/cells=[]。core 发送平铺的 sheet_id/row_start 等字段，后端却读取 body.range。TableViewer 用 artifactId 当 sheetId，没有加载工作簿或切换工作表；使用 0 起始坐标，转换器/方案用 1 起始。grid 又只根据有值单元格生成行列，空白行列布局会被压缩。没有 Univer。

**已复现：** 请求 sheet_2、50~100 行得到 sheet1、0~0、空数据；浏览器仅显示翻页按钮和 coverage 0/?。PROGRESS.md 所说“返回未实现错误”已与实际代码不符。

修复：未实现时先明确返回错误；随后实现固定发布版本的索引/分块窗口读取、窗口预算、真实 sheetId、统一坐标、可见表默认选择、常规/大表两条渲染路径。

### R09 · P1：Excel 丢失关键显示语义

位置：[spreadsheet.py:52](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/spreadsheet.py:52)、[spreadsheet.py:131](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/spreadsheet.py:131)。

data_only=False 后直接 str(value)，没有读取保存的公式缓存，没有 SSF 数字格式，没有单元格完整类型/样式。read_only 工作表没有补 OOXML 元数据，合并、隐藏行列、冻结、默认活动表等信息缺失；XLS 分支直接把所有表设为 visible。达到 cell_budget 后 shown_row_end 仍用预估 row_count。

**已复现：** 25% 显示为 0.25；=1+1 显示公式字符串；A2:B2 合并输出为空；冻结 B2 输出 0/0；隐藏列信息缺失。该方向会重复此前 GDPVal 的“数值在，但打开与显示规则不对”问题。

修复：按方案同时保留原值/公式/缓存/number_format/display_value；补 OOXML 显示元数据；在真实语义样本上核对，而非只检查 chunk 非空。

### R10 · P1：partial 被发布为 ready，界面没有完整性提示

位置：[orchestrator.ts:342](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:342)、[orchestrator.ts:366](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:366)、[file-preview.tsx:88](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/file-preview.tsx:88)。

最终 manifest 和 Store 发布均硬编码 ready；候选 completeness 不参与计算。toState 的 warnings 固定空数组；FilePreview 不展示 manifest/representation 的 warnings、coverage 或降级原因。Notebook 省略富输出、裁剪输出时也没有完整传播 partial。

**已复现：** candidate availability=partial 且 representation partial，最终仍 succeeded/ready。对业务意味着“只显示一部分，却告诉用户预览好了”。

修复：按 representation 状态和 affects_completeness 聚合；无法确认完整则 partial；通过 state、manifest、界面一致显示缺失范围。合法空内容和解析失败必须分开。

### R11 · P1：损坏 PDF 被当作可用结果，Office PDF 缺少结构验证

位置：[pdf.py:57](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/pdf.py:57)、[pdf.py:73](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/pdf.py:73)、[office_pdf.py:86](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/office_pdf.py:86)。

pypdf 解析失败被吞掉，退化为文件头/EOF 检查后仍 ready；Office 分支只找到 *.pdf、复制并算摘要，没有调用它注释中声称的 PDF 可打开性验证。

**已复现：** `%PDF-1.4\nnot a PDF document\n%%EOF` 返回 ok=true、availability=ready。

修复：区分解析器缺失与文件损坏；要求可打开性/页数/基本结构验证；Office 输出复用相同验证。损坏文件不能被标为 fallback 成功。

### R12 · P1：资源和宿主输出验证边界未落地

位置：[orchestrator.ts:216](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:216)、[orchestrator.ts:282](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/orchestrator.ts:282)、[pdf.py:87](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/pdf.py:87)、[office_pdf.py:97](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/office_pdf.py:97)。

host 全量收集原文件 chunks 再分配第二份连续数组，没有源大小硬上限；运行器返回的 relativePath 被直接 join/readFile，未检查目录穿越/软链接或在宿主重新校验摘要/MIME/引用。Python 的 PDF/Office copyfile 绕过 SandboxFs 的累计输出预算；子进程 timeout 只杀 Python worker，不能作为 LibreOffice 进程树已终止的证据。容器 CPU/内存/网络限制目前没有实际 Runner 落实。

**已复现：** 配置 output_bytes=5000 时，合法 PDF 派生副本 20,437 字节仍 ok=true。其他边界由源码确认，未尝试访问业务文件或制造内存耗尽。

修复：源文件流式落盘并实时限额/摘要；宿主独立校验每个候选路径、大小、摘要和引用；统一所有写盘路径预算；由受限 Runner 对容器与进程树实施硬限制。

### R13 · P1：身份/client 切换沿用旧预览 ID

位置：[use-preview.ts:86](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/hooks/use-preview.ts:86)、[use-preview.ts:129](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/hooks/use-preview.ts:129)、[http-client.ts:253](/Users/gelx/Desktop/code/unipat-file-preview/packages/core/src/http-client.ts:253)。

usePreview 的 bootstrap effect 仅依赖文件 key；替换 client、切登录/租户但 resourceKey/version 不变时不会重新 getState。没有设计的 identityKey/authCacheKey。artifactCache 的实际 key 也不含身份，fresh 命中会跳过网络；该风险在接入方给出 max-age 的响应时成立。

**浏览器已复现：** A client getState→fetchManifest A；切 B 后只有 `B fetchManifest A`，没有 B getState。测试返回合成文本，没有获取真实他人数据。

修复：明确身份代际，client/身份变化时终止旧请求、清空 state/manifest/内容缓存、重新加载；异步结果还需比较请求代际，不能只比较 mountedRef。

### R14 · P1：DICOM 的颜色和像素变换路径不符合约定

位置：[dicom.py:83](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/dicom.py:83)。

用 pixel_array.ndim==2 判断单帧，RGB 单帧通常是 rows×cols×3，会被当作多帧逐行处理；所有结果最终强制 mode=L。没有 Modality LUT/Rescale 步骤，先完整解码 ds.pixel_array 才截帧，也不是方案要求的逐帧预算控制。

**源码确认，未运行 DICOM 样本：** 本机当前 Python 缺少 pydicom。不能据此宣布 DCM/DICOM 支持验收通过。

修复：按 NumberOfFrames/SamplesPerPixel/PhotometricInterpretation 分派；应用规定的像素变换序列；真正逐帧解码；加入灰度/彩色/压缩/多帧合成测试。

### R15 · P2：PDF 首次渲染全部页面，缺少阅读能力与资源隔离

位置：[pdf-viewer.tsx:24](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/pdf-viewer.tsx:24)、[pdf-viewer.tsx:99](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/pdf-viewer.tsx:99)。

fetchArtifact 全量下载 PDF，然后循环每页创建 Canvas，缩放时全部重画；没有可视区域回收/有限页缓存、页码跳转、文本层或搜索。长文档会按页数和缩放平方增加 Canvas 内存。还修改 GlobalWorkerOptions，可能影响宿主共存实例；没有 CMap/字体/资产 manifest 接入。

**已验证的正向结果：** 修正示例代理后，DemoRunner 的单页 PDF 显示成功；Vite 生产构建确实输出了 Worker 和独立 pdf chunk。因此没有把 Worker 路径猜测为已确认故障。长文档/中文 PDF/多实例尚未验收。

修复：可见页渲染与释放、完整阅读工具、实例级 Worker 与自托管资产配置；再验证长中文文档和同页多实例。

### R16 · P2：TTL 清理破坏索引，同一文件无法再次打开

位置：[inmemory/store.ts:508](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/inmemory/store.ts:508)。

sweepExpired 删除 previews，却留下 previewByKey。下一次 ensurePreview 找到旧 id 后访问不存在的 row。无显式 expireAt 的 failed/cancelled 分支 dueAt 计算恒等于 now，因此下一次扫描立即删除；删除对象失败被吞掉，元数据已丢失，后续无法可靠重试。

**已复现：** sweep 后再次 ensure 同文件报 `Cannot read properties of undefined (reading 'row')`。

修复：同步维护索引；清理使用固定目标和真实时间戳；对象删除失败保留可重试记录；不要默认 24h 自动删除方案要求持续保留的当前结果。

### R17 · P2：开放 Range 返回巨大虚假 Content-Length

位置：[http.ts:411](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/http.ts:411)、[host.ts:362](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/host.ts:362)。

bytes=2- 被解析为 end=Number.MAX_SAFE_INTEGER，未按实际长度裁剪。非法/后缀 Range 静默退化为全量读取，超界和反向范围也缺少 416 语义。

**已复现：** 156 字节文件返回 206、Content-Length=9007199254740990、Content-Range=`bytes 2-9007199254740991/156`。客户端可能等待不存在的字节或报传输失败。

修复：已鉴权并取得 stat 后规范化 Range；覆盖开放、后缀、越界、空文件、多区间拒绝等情况。

### R18 · P2：首次清单读取失败永远显示加载中

位置：[file-preview.tsx:68](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/file-preview.tsx:68)。

`if (combinedLoading || !manifest)` 排在 manifestError 前。首次读取清单失败时 manifest=null，即使错误已经保存，错误分支也无法到达。

**浏览器已复现：** 合成 fetchManifest 拒绝 ACTION_FORBIDDEN，页面仍显示 `Preparing preview… publishing`。

修复：优先处理 manifestError，再判断加载/空态；确保 renderError 接管所有层级错误。

### R19 · P2：人工重试 API 没有贯通

位置：[use-preview.ts:272](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/hooks/use-preview.ts:272)、[inmemory/store.ts:372](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/inmemory/store.ts:372)、[http-client.ts:30](/Users/gelx/Desktop/code/unipat-file-preview/packages/core/src/http-client.ts:30)。

Store 有 enqueueRetry，但 host/client/HTTP 没有对应 retry 方法。UI Retry 调 refresh→getState→generate，ensure 对 failed/cancelled 保持终态，不能开始新 generation。clear 后也无法经公开 API 再生成。clear hook 本身不清除当前内容或刷新状态。

源码确认。修复：按方案提供鉴权、幂等的 retry；UI 重试调用它；clear 成功立即清除可见内容和缓存。

### R20 · P2：HTML 清理丢尾部内容，浏览器隔离与方案不一致

位置：[html_sanitize.py:73](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/html_sanitize.py:73)、[html-viewer.tsx:21](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/html-viewer.tsx:21)、[html-viewer.tsx:139](/Users/gelx/Desktop/code/unipat-file-preview/packages/react/src/html-viewer.tsx:139)。

input/embed 是无结束标签元素，却被压入 skip_stack；后续正常内容一直被跳过。HtmlViewer 使用 allow-same-origin，未执行组件侧受控重建/CSP 插入，而且沿用 text/plain MIME，真实产物将显示源码。外链仍保留主动 href；CSS 用分号拆分而没有使用已声明的 tinycss2 解析。

**已复现：** `<p>before</p><input><p>after</p>` 仅剩 before。这里没有声称已复现脚本执行；当前 iframe 没有 allow-scripts。

修复：处理 void 元素和合法尾文本；按方案空 sandbox+受控 srcdoc；清理与展示使用同一真实样本测试，禁止通过放宽隔离修复排版。

### R21 · P2：GBK 文本被误判 UTF-16 且无告警

位置：[_common.py:41](/Users/gelx/Desktop/code/unipat-file-preview/converter/src/converter/processors/_common.py:41)。

无 BOM 时依次尝试 UTF-8、UTF-16、GBK。很多偶数字节 GBK 内容可以被 UTF-16 解码为错误字符，因此永远不会尝试 GBK，还标 uncertain=false。

**已复现：** GBK 编码“中文内容”被解为 `탖쓎󁇈`，chosen=utf-16、uncertain=false。影响 TXT/CSV/HTML 等共享该工具的处理器。

修复：UTF-16 需要 BOM 或充分的编码特征；不确定时记录告警，增加真实中文编码样本。

### R22 · P1：一键装配会和已有 HTTP Server 处理器同时写响应

位置：[install.ts:124](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/install.ts:124)、[http.ts:63](/Users/gelx/Desktop/code/unipat-file-preview/packages/node/src/http.ts:63)。

installFilePreview(server) 直接新增 request listener。已有业务 handler 不会被短路；新 handler 对不匹配预览路径还直接 404。接入已有 Node/Express server 时，同一个请求可能被两套 listener 同时处理，导致重复响应/headers sent，甚至普通业务路由受到影响。

源码确认，未向用户运行中的业务 server 挂载。修复：提供显式 middleware/路由适配器并通过 next/handled 语义组合；不能把 server.on 当路由挂载。空 server 独占模式另行说明并测试。

## 4. 已知未完成项和其他应补边界

以下按最新公共包边界重新判断，不把原方案中的基础设施占位计为公共包交付缺陷。

- MySQL、生产 Storage/调度 Runner、源失效通知、跨节点事件和恢复属于项目职责，不要求在公共包补齐。转换工具自身的版本、输入输出和安全约束仍需明确。
- HTTP 路由和成功响应从方案的 `/previews`、`{request_id,data}` 等改成 `/generate` 和直接对象；前后端暂时互通不代表满足既有接入文档。需要明确版本并统一文档与实现。
- 幂等键未完整用于 retry/cancel/clear；ensure 预留后异常没有释放/失败记录，可能持续 REQUEST_IN_PROGRESS 到 TTL；scope 缺少用户/租户隔离；请求摘要使用 32 位 simpleHash。
- 原文件未提供 expectedSha256 时，verifiedSha256 没有持久化使用；源版本不变但字节变化的保护未闭合。
- SSE 使用内存 event bus，默认 longpoll 参数与 `/state` 的必填 file/profile 不匹配；就算修复当前定时器单测，也要跑真实 handler。
- Request body 缺少字节限额、字段长度/类型/范围校验；未知异常直接把内部 error.message 返回给客户端。
- PDF/Office/图像/DICOM 的真实镜像、字体和解码器自检未验证；Dockerfile 注释不等于实际启动参数落实。压缩包展开/深度等预算未见落地。
- Gallery 没有按帧索引读取对应缩略图；PDF 缺少完整阅读能力；样式主要是内联 style，尚未提供设计的 styles.css、theme、cspNonce 和资产复制命令。
- 所有包仍 private，React 示例使用 18，未完成文档承诺的 React 19 验收；dist 成功不等于可发布。

## 5. 实际验证结果

| 检查 | 本次结果 |
|---|---|
| pnpm -r run build | 通过 |
| pnpm -r run typecheck | 通过，包含 React 示例 |
| core 单测 | 53 项，52 通过、1 失败；longpoll URL 测试 captured=undefined |
| node 单测 | 单独运行 8/8 通过 |
| golden | 3/3 通过；只校验固定 golden，没有验证真实 converter 输出 |
| converter unittest | 从 converter 目录运行，17/17 通过 |
| Vite production build | 通过，输出独立 PDF chunk 与 Worker；产物放临时目录 |
| 原始 React 示例浏览器 | 默认 API 为 /api/file-preview/v1，proxy 只匹配 /v1，页面 404 |
| 临时代理后的示例 | 合成单页 PDF 可显示；表格只有导航和 coverage 0/?，无数据 |
| 独立 React 合成回归 | client 切换仍沿用 A preview ID；清单错误被 loading 分支遮蔽 |
| host 合成复现 | 跨租户读取、GET 生成、源失效仍可读、清理后复活、过期租约续期、TTL 索引损坏、partial→ready、错误 Range、空表格响应已复现 |
| converter 合成复现 | XLSX 显示信息缺失、input.bin 拒绝、无效 PDF 成功、HTML 尾文本丢失、GBK 错解、PDF 输出预算绕过已复现 |

core 失败测试使用 setImmediate 等待 setTimeout(0) 的执行，存在时序依赖；本次不把它直接等同于稳定的线上功能故障。但“53 pass”不能当作本次验证结论。

限制：未完成 28 扩展名逐格式浏览器验收；未构建/部署 converter Docker；未运行 DICOM 样本；未执行真实 Office 文件转换。没有验证实际业务项目接入。不能从 17 个 Python 测试推导出这些能力已通过；数据库/OSS/K8s 实现不再作为公共包自身的验收门槛。

复现脚本：[host](probe-host.mjs)、[converter](probe-converter.py)；本机运行结果：[host-results.txt](host-results.txt)、[converter-results.txt](converter-results.txt)。脚本路径面向当前工作区，全部使用内存或临时合成文件。

## 6. 建议的返工顺序与验收门槛

1. **先收紧边界。** 修订原方案与 PROGRESS，将数据库、生产存储、任务调度/租约/恢复、长期清理移出公共包职责。已有 host 编排代码评估移入业务项目或独立示例；不能一边移出职责，一边要求补齐其生产实现。
2. **贯通真实最小链路。** 固定转换输入输出与公开产物协议；测试夹具提供临时文件读取，不依赖 MySQL/OSS。TXT、中文 PDF、含百分比/公式/隐藏表的 XLSX、HTML、PNG、Notebook 必须从真实字节转换，最终在浏览器看到准确内容。
3. **修转换和渲染本身。** 补 Excel 显示语义、PDF 可打开性与按页阅读、文本分块、Notebook 输出、HTML 隔离、帧索引和 DICOM 变换；partial 可见；修身份切换、错误态、请求取消及资源预算。
4. **做一个真实业务接入验证。** 项目用自己的认证、数据库、任务与存储，通过最小接口调用公共包。现有 host 风险若代码被项目保留，需在项目边界修复；不把它们塞回公共包。
5. **验收公共包发布。** CI 执行真实转换/渲染样本；React 19、SSR、多实例、卸载/切租户；pack 后资源完整；明确转换工具版本；保证安装和使用公共包不启动后台扫描、不建表、不接管项目存储。

可以保留内存 Store、EchoRunner、DemoRunner 作为教学和单元测试夹具，但不应再使用这些示例的成功截图或计数来证明公共库生产能力。暂不建议先扩大 UI 功能或继续增加处理器名字；优先让现有层真正相接，并让错误和缺失内容如实到达用户。
