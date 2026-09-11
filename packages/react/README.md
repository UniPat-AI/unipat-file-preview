# @unipat/file-preview-react

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
pnpm add @unipat/file-preview-react
# 或
npm install @unipat/file-preview-react
```

## 快速使用

### 1. 基础用法（直接传 URL）

```tsx
import { FilePreview } from '@unipat/file-preview-react';

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
import { FilePreview } from '@unipat/file-preview-react';

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
import { FilePreview, type PreviewPlugin } from '@unipat/file-preview-react';

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
