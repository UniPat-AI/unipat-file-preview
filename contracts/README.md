# contracts

`contracts/` 是公共文件预览库的**跨语言契约层**：错误码、协议类型、清单结构、支持格式清单、schema 版本都以这里的定义为唯一来源。

- TypeScript 侧：`src/` 下所有 `.ts` 文件由 `packages/core` 再导出，供前端与 Node 后端消费。
- Go 侧：`host-go` 在构建时读取本目录（或由生成脚本产出的镜像结构体），保证两个后端字段一致。
- JSON Schema / SQL 升级 / 行为样本：见根目录 [`PROGRESS.md`](../PROGRESS.md)，仍在待办中。

修改本目录任何字段都属于契约变更，必须同步升级 `MANIFEST_SCHEMA_VERSION` 或 `HTTP_PROTOCOL_VERSION` 常量。
