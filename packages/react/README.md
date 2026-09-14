# @unipat-ai/file-preview

开箱即用的前端文件预览 React 组件库。基于现代插件化架构设计，自动根据文件类型调度专属插件渲染，零后端依赖，支持自定义扩展。

## 特性

- 🚀 **开箱即用**：只需传入文件 URL、本地 `File` 对象或 `Blob`，一行代码即可渲染预览。
- 🧩 **插件化架构**：不同格式由独立专属插件处理，支持业务方注入自定义插件。
- 📦 **内置全套格式支持**：
  - **PDF 插件**：基于浏览器具身与 PDF.js，支持多页浏览、缩放与全屏。
  - **图片插件**：支持 JPG、PNG、GIF、SVG、WebP、BMP 等，支持放大/缩小/旋转/复位。
  - **JSON 专属插件**：DevTools 级交互体验，支持树形节点按需折叠/展开、字段数量标签、类型色彩高亮、关键字实时搜索、点击节点一键复制、以及树形/原始代码双模切换。
  - **表格插件**：纯前端解析并渲染 CSV、TSV，支持固定表头、分页与行列对齐。
  - **文本与代码插件**：支持 TXT、Markdown、JS、TS、SQL、YAML、Log 等，支持行号展示与一键复制。
  - **音视频多媒体插件**：支持 MP4、WebM、OGG 视频播放及 MP3、WAV、AAC、FLAC 音频播放。
  - **HTML 插件**：严格受控空沙箱（`sandbox=""`）安全隔离展示。
  - **兜底插件**：优雅的文件卡片展示，支持未知格式友好提示与直接下载。
- 🔄 **微服务兼容模式**：向后兼容企业级文件转码微服务与大文件流式切片协议。

## 安装

```bash
pnpm add @unipat-ai/file-preview
# 或
npm install @unipat-ai/file-preview
```

## 快速使用

### 1. 基础用法（直接传 URL）

```tsx
import { FilePreview } from '@unipat-ai/file-preview';

function App() {
  return (
    <div style={{ height: 600 }}>
      {/* 自动识别扩展名并调度对应插件 */}
      <FilePreview src="https://example.com/files/annual-report.pdf" />
    </div>
  );
}
```

### 2. 预览用户本地上传的 File / Blob

```tsx
import { useState } from 'react';
import { FilePreview } from '@unipat-ai/file-preview';

function Uploader() {
  const [file, setFile] = useState<File | null>(null);

  return (
    <div>
      <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {file && (
        <FilePreview
          src={file}
          fileName={file.name}
          style={{ height: 500, marginTop: 16 }}
        />
      )}
    </div>
  );
}
```

### 3. 自定义扩展插件

你可以随时编写并注入自己的预览插件（例如支持 DICOM 医疗影像、3D 模型、特定业务图表等）：

```tsx
import { FilePreview, type PreviewPlugin } from '@unipat-ai/file-preview';

const My3DPlugin: PreviewPlugin = {
  name: 'my-3d-model',
  match: (fileType) => ['gltf', 'glb', 'obj'].includes(fileType),
  Component: ({ src, fileName }) => {
    return <div>这里调用 Three.js 渲染 3D 模型：{fileName}</div>;
  },
};

// 注入自定义插件（优先匹配）
<FilePreview
  src="https://example.com/models/robot.glb"
  plugins={[My3DPlugin]}
/>
```

## Props 说明

| 属性 | 类型 | 说明 |
| :--- | :--- | :--- |
| `src` | `string \| File \| Blob` | **必填**。文件网络链接、本地 File 对象或 Blob 对象 |
| `fileType` | `string` | 可选。文件扩展名（如 `'pdf'`, `'csv'`），不传自动从 URL 或文件名探测 |
| `fileName` | `string` | 可选。用于展示与下载提示的文件名 |
| `plugins` | `PreviewPlugin[]` | 可选。自定义扩展插件数组（优先于内置插件进行匹配） |
| `className` | `string` | 可选。外层容器类名 |
| `style` | `CSSProperties` | 可选。外层容器行内样式 |
| `onLoad` | `() => void` | 可选。文件加载完成回调 |
| `onError` | `(err: Error) => void` | 可选。加载或渲染失败回调 |

## 压缩文件只读预览（0.3.1）

默认内置 `ArchivePlugin`，不需要后端转码服务或 AI Runner：

```tsx
<FilePreview
  src={authorizedBlob}
  fileName="target_roster.tsv.gz"
  allowDownload={false}
  allowOpen={false}
  allowPrint={false}
  archiveLimits={{ maxEntryBytes: 16 * 1024 * 1024, maxDepth: 3 }}
/>
```

- `.tsv.gz`、`.csv.gz`、`.json.gz` 等单文件 GZIP：解压后根据去掉 `.gz` 的文件名复用原有表格、JSON、文本等插件。
- `.zip`：先读取目录，按文件夹浏览、返回上级，点击文件后才解压该文件；支持 ZIP 内 GZIP 和嵌套 ZIP。
- `.tar`、`.tar.gz`、`.tgz`：支持 USTAR、PAX 路径和 GNU 长文件名，显示包内目录并点击预览；TAR.GZ 按一层归档计数。拒绝硬链接、稀疏文件和损坏的文件头。
- 自定义 `plugins`、`disabledPlugins`、下载／打开／打印权限传递给所有内部预览；HTML 仍使用原有空 sandbox。可通过 `disabledPlugins={['archive']}` 禁用压缩预览。
- 仅在浏览器内存中解压，不执行脚本，不上传、不保存或修改原文件，不产生业务草稿。鉴权、版本绑定、审计等仍由宿主提供。

默认限制：输入 32 MiB、单文件解压 16 MiB、单归档声明的解压总量 64 MiB、2000 个条目（含目录）、最多 3 层、每次读取／解压 30 秒。`archiveLimits` 可覆盖这些正整数设置。ZIP 在解压前检查目录限额，解压流也检查实际输出上限并验证 CRC；GZIP 通过流式计数限制实际输出。限制按每层归档生效，只保留当前选中文件；切换文件或卸载时取消旧读取。表格沿用现有分页，在限额内完整加载，不提供超大归档的服务端分片或全包搜索。

首期不支持 RAR、7z、ZIP64、分卷、加密、非 UTF-8 文件名和 Stored/Deflate 以外的 ZIP 算法；异常内容显示错误，不自动下载或执行。拒绝路径穿越、绝对路径、重复路径、符号链接及特殊文件。浏览器须支持 `DecompressionStream` 的 `gzip` 和 `deflate-raw`，不支持时显示错误。

### 宿主接入注意

宿主必须允许读取压缩文件原始字节；如果平台在 API 或界面层提前判为 unsupported，升级本包不会自动绕过限制。推荐鉴权后传入 Blob，并保留原始 `fileName`；不要把 `.tsv.gz` 的 `fileType` 显式设置成 `tsv`，让组件识别 `gz` 后解压。服务器可以返回 `application/gzip`、`application/zip`、`application/x-tar` 或 `application/octet-stream`，**不要把文件本身的 GZIP 层同时声明为 HTTP `Content-Encoding: gzip`**，否则浏览器会在 fetch 前自动解压而与文件名不符。HTTP 传输压缩应与原文件的字节层严格区分。

可运行独立浏览器验收示例：`pnpm --filter @unipat/file-preview-example-archive dev`。样例涵盖 GZIP TSV、ZIP 内 JSON／GZIP／HTML；关闭下载、外跳与打印。示例 GZIP URL 使用 `.bin` 后缀，避免开发服务器自动设置 HTTP Content-Encoding。
