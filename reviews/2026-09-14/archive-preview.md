# 压缩预览包 0.3.0 验收

新增 ArchivePlugin，在 React 包内支持 GZIP 单文件和 ZIP 目录浏览。平台没有做任何改动；宿主仍须允许获取压缩文件字节并提供原始文件名。

真实浏览器（Codex in-app Chromium，2026-09-14）已验证独立示例：GZIP TSV 表格、ZIP 目录进入和返回、ZIP 内 GZIP 表格及 JSON、HTML 空 sandbox 下脚本未执行。下载／打开／打印关闭后未出现相关入口。示例见 examples/archive-preview。

自动验证：pnpm install、全仓 build；React 包 23 项测试（新增 8 项），覆盖解压上限、完整性、非法路径、符号链接、重复路径、数量、取消、实际 React 分发、权限传递与嵌套层数；全部 package 测试与 pack dry-run 均通过。

全仓 typecheck 存在既有示例问题：examples/react-web/src/app.tsx 引用旧 @unipat/file-preview-react，改为新包名后又暴露 core 与 React 自带契约 JobStage 不一致。此为既有微服务示例，不扩展本次压缩功能范围，未修改该示例。React 包本身构建及类型检查通过。

边界：当前不支持 TAR/TAR.GZ、RAR、7z、ZIP64、加密或分卷；限额内完整预览、超限明确报错，不提供服务端分页解压。浏览器须支持 DecompressionStream gzip/deflate-raw。GZIP 原始内容不可同时以 HTTP Content-Encoding:gzip 下发，避免浏览器自动解压；详见包 README。
