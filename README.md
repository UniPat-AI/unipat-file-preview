# @unipat-ai/file-preview

开箱即用的前端文件预览 React 组件库。采用现代轻量级插件化架构设计，在浏览器端零后端依赖直接解析渲染各种常见文件，自动根据文件扩展名调度专属插件，并支持业务方按需注入自定义插件扩展。

[![npm version](https://img.shields.io/badge/npm-@unipat--ai/file--preview-blue.svg)](https://github.com/UniPat-AI/unipat-file-preview)
[![license](https://img.shields.io/badge/license-UNLICENSED-green.svg)](LICENSE)

---

## 📑 支持的文件格式一览

组件内置了全套纯前端预览插件，能够直接解析以下常用格式，并提供针对该格式优化的交互体验：

| 分类 | 支持的扩展名 | 核心功能与交互体验 | 渲染机制 |
| :--- | :--- | :--- | :--- |
| **PDF 文档** | `.pdf` | 多页浏览、全屏展示、新标签页打开、原生缩放/打印工具栏 | 浏览器原生嵌入 + PDF.js 降级兼容 |
| **图片** | `.jpg`, `.jpeg`, `.png`, `.gif`, `.svg`, `.webp`, `.bmp`, `.ico` | 顺时针 90° 旋转、放大缩小（25%~400%）、一键复位、居中抗锯齿渲染 | 浏览器图片渲染引擎 |
| **数据交换** | `.json`, `.jsonl` | DevTools 级树形折叠展开、字段数量标签、类型颜色高亮、实时文本搜索过滤、一键复制字段值、树形/原始文本双模切换 | 纯前端高效 JSON 解析器与虚拟树 |
| **表格文件** | `.csv`, `.tsv` | 智能推导分隔符（逗号、Tab、分号）、表头固定、前端分页浏览（每页 50 条）、行列边界自适应对齐 | 纯前端轻量流式解析 |
| **代码与纯文本** | `.txt`, `.text`, `.md`, `.markdown`, `.log`, `.ini`, `.conf`<br/>`.js`, `.jsx`, `.ts`, `.tsx`, `.py`, `.java`, `.go`, `.rs`, `.c`, `.cpp`, `.sql`, `.sh`, `.bash`, `.yaml`, `.yml`, `.xml`, `.css` | 代码行号显示、等宽字体排版、溢出水平滚动、一键复制完整文本内容 | 纯前端 UTF-8 文本流渲染 |
| **音视频多媒体** | **视频**：`.mp4`, `.webm`, `.ogg`<br/>**音频**：`.mp3`, `.wav`, `.aac`, `.m4a`, `.flac` | 原生播放控件、时间轴拖拽、音量调节、全屏播放；音频带专属封面与音乐卡片展示 | HTML5 Video / Audio 原生硬件加速 |
| **网页文档** | `.html`, `.htm` | 沙箱安全隔离展示，自适应容器宽高 | 受控空沙箱 `iframe (sandbox="")` |
| **压缩与归档** | `.zip`, `.tar`, `.tar.gz`, `.tgz`, `.gz`<br/>*(以及 `.csv.gz`, `.tsv.gz`, `.json.gz` 等单文件流)* | 纯前端解压只读浏览、目录树导航、层级进入与返回、包内选中文件即时无缝预览；严格防范路径穿越与内存炸弹 | 浏览器原生 `DecompressionStream` |
| **Jupyter** | `.ipynb` | Notebook 单元格结构还原、Markdown 描述展示、输入输出代码块渲染 | 专用 Notebook Viewer |
| **其他未知格式** | *所有未匹配格式* | 优雅的文件信息卡片展示、文件类型徽标提示、一键安全下载文件到本地 | 兜底下载插件（Fallback Plugin） |

---

## 📦 安装

```bash
# pnpm
pnpm add @unipat-ai/file-preview

# npm
npm install @unipat-ai/file-preview

# yarn
yarn add @unipat-ai/file-preview
```

> **注意**：本组件库将 React 作为 `peerDependencies`（要求 React `>=18`），不会在包内捆绑重复的 React 实例。

---

## 🚀 快速上手

### 1. 基础用法：直传 URL

只需传入网络文件直链，组件将自动根据 URL 后缀识别文件类型并调度最佳插件展示：

```tsx
import { FilePreview } from '@unipat-ai/file-preview';

export function DocumentModal({ fileUrl }: { fileUrl: string }) {
  return (
    <div style={{ height: 600, width: '100%' }}>
      <FilePreview src={fileUrl} />
    </div>
  );
}
```

### 2. 预览用户本地上传的 File / Blob（无需预先上传服务端）

用户通过 `<input type="file" />` 选取本地文件后，可无需上传至 OSS 直接在前端即时预览：

```tsx
import { useState } from 'react';
import { FilePreview } from '@unipat-ai/file-preview';

export function FileUploaderPreview() {
  const [file, setFile] = useState<File | null>(null);

  return (
    <div>
      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      {file && (
        <div style={{ height: 600, marginTop: 16 }}>
          <FilePreview
            src={file}
            fileName={file.name}
            onLoad={() => console.log('文件加载完成')}
          />
        </div>
      )}
    </div>
  );
}
```

### 3. 自定义扩展插件

你可以针对特殊行业或专有格式（如 DICOM 医疗影像、3D 模型、CAD 图纸等）注入自定义插件，自定义插件会优先于内置插件进行匹配：

```tsx
import { FilePreview, type PreviewPlugin } from '@unipat-ai/file-preview';

// 编写自定义 3D 模型插件
const Model3DPlugin: PreviewPlugin = {
  name: '3d-viewer',
  match: (fileType) => ['glb', 'gltf', 'obj'].includes(fileType),
  Component: ({ src, fileName }) => {
    return <div>这里调用 Three.js 渲染 3D 模型：{fileName}</div>;
  },
};

// 在组件中注入
<FilePreview
  src="https://example.com/assets/robot.glb"
  plugins={[Model3DPlugin]}
/>
```

---

## ⚙️ Props 属性说明

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| `src` | `string \| File \| Blob` | **是** | - | 文件的网络链接、本地 File 对象或 Blob 二进制数据 |
| `fileType` | `string` | 否 | 自动探测 | 文件格式（小写不带点，如 `'pdf'`, `'csv'`），未提供时根据 URL 或文件名自动探测 |
| `fileName` | `string` | 否 | 自动推导 | 用于界面头部展示、全屏标题及兜底下载提示的文件名 |
| `plugins` | `PreviewPlugin[]` | 否 | `[]` | 业务方自定义扩展插件列表，优先于内置插件进行匹配 |
| `className` | `string` | 否 | `''` | 容器外层自定义 CSS 类名 |
| `style` | `React.CSSProperties` | 否 | `{}` | 容器外层行内样式（建议设置固定高度或 `height: 100%`） |
| `onLoad` | `() => void` | 否 | - | 文件数据及界面渲染成功后的回调函数 |
| `onError` | `(err: Error) => void` | 否 | - | 发生网络错误、解析错误或不支持时触发的回调函数 |

---

## 💡 生产使用建议

1. **容器高度**：所有查看器组件均采用自适应弹性布局（`height: 100%`）。在 Modal、Drawer 或普通页面中使用时，请为外层父容器指定固定高度（如 `height: 600px` 或 `height: 80vh`）。
2. **跨域 CORS**：文本类文件（JSON、CSV、TXT）前端需要通过浏览器 `fetch()` 获取文本数据，若文件存储于 OSS/S3，需确保存储桶的 CORS 规则允许业务域名发送 `GET` 请求。
