# converter

基于 Python + LibreOffice 的统一转换容器。把「一份不可变源文件」转成受控展示产物（PDF / CSV / 图像 / HTML / JSON / Notebook 结构等），供 host 的 Orchestrator 消费后发布为 preview。

## 特性

- **单一入口**：所有处理器共用 `(ctx: ProcessorContext) -> Manifest` 签名，输出遵循 `docs/03` §2 的公开清单结构。
- **零依赖冒烟**：`plain_text` / `structured_text` / `csv` / `notebook` / `html_sanitize` / `pdf` 全部只用 Python 标准库；镜像里安装 LibreOffice / Pillow / pydicom / openpyxl 后自动激活其他处理器。
- **沙盒 IO**：所有产物写入 `SandboxFs`，拒绝 `..` / 绝对路径 / 软链接；先写临时文件后原子改名；实时累加字节，超预算立即 `OUTPUT_TOO_LARGE`。
- **强完整性**：处理器写完清单后再由 runtime 复核每个 artifact 的实际 SHA-256 / size；不一致直接拒绝发布，避免 processor 声称成功但产物不完整。
- **稳定错误码**：与 `docs/03` / `docs/04` 一致，例如 `PASSWORD_REQUIRED`、`CONVERSION_TIMEOUT`、`SOURCE_SHA_MISMATCH`、`DEPENDENCY_UNAVAILABLE`、`RICH_OUTPUT_OMITTED`。
- **HTTP 服务**：`/convert`（子进程隔离 + 硬性 wall-time 超时 + 幂等输出布局）、`/healthz`、`/metrics`（Prometheus 文本格式）。
- **CLI**：`python -m converter --request /input/request.json`，用于 host 直接以子进程方式调用镜像。
- **Docker 镜像**：非 root 运行，`docker run --network=none --read-only` 下工作。

## 目录

```
converter/
├── Dockerfile               # LibreOffice + Python 运行环境（非 root）
├── pyproject.toml           # 包声明；可选依赖：spreadsheet/image/dicom/html_sanitize/xml_safe/all
├── README.md                # 本文
├── src/converter/
│   ├── __init__.py          # 公共 API 再导出
│   ├── __main__.py          # `python -m converter` 入口
│   ├── cli.py               # 命令行主体
│   ├── contracts.py         # ConvertRequest / Manifest / Coverage 等
│   ├── errors.py            # 稳定错误码
│   ├── runtime.py           # 上下文构造 / 超时预算 / 处理器分发
│   ├── sandbox_fs.py        # 受限输出文件系统 + SHA-256 + LRU 字节预算
│   ├── server.py            # http.server 版 HTTP 服务
│   └── processors/
│       ├── plain_text.py    # TXT / MD
│       ├── structured_text.py # JSON / XML / XBRL（DTD/实体安全解析）
│       ├── csv_processor.py # CSV 分块（≤1000 行 / 4 MiB）
│       ├── notebook.py      # IPYNB 静态结构 + 富输出省略
│       ├── html_sanitize.py # 白名单标签/属性 + CSP meta + data: image
│       ├── pdf.py           # 头/EOF 校验 + 加密判定 + source_reference
│       ├── office_pdf.py    # DOC/DOCX/RTF/PPT/PPTX → PDF via LibreOffice
│       ├── spreadsheet.py   # XLS(xlrd) / XLSX/XLSM(openpyxl) 分块 + 工作簿索引
│       ├── image.py         # PNG/JPG/BMP/WEBP/TIFF 多帧（Pillow）
│       └── dicom.py         # DICOM 逐帧解码 + 灰度/彩色窗宽窗位
└── tests/                   # unittest 冒烟；17 case，含 HTTP 端到端
```

## 快速上手

```bash
# 0. 进入目录
cd converter

# 1. 单测（纯标准库处理器即可跑通）
PYTHONPATH=src python -m unittest discover -s tests

# 2. 启动 HTTP 服务（默认监听 0.0.0.0:8081）
PYTHONPATH=src python -m converter.server --host 127.0.0.1 --port 8081

# 3. 单次调用（等价于容器内一次 job）
PYTHONPATH=src python -m converter --request ./request.json
```

`request.json` 结构对齐 `docs/03` §1：

```json
{
  "contract_version": "1.0",
  "job_id": "job_01",
  "source": {
    "path": "/input/source.xlsx",
    "extension": "xlsx",
    "size_bytes": 183200,
    "sha256": "<sha256>"
  },
  "profile": { "id": "standard-v1", "digest": "<digest>" },
  "output_dir": "/output",
  "limits": { "wall_time_seconds": 480, "output_bytes": 2147483648 }
}
```

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 返回 `{status, uptime_seconds}` |
| GET | `/metrics` | Prometheus 文本，包括 `converter_requests_total/ok/failed/timeout` 与 `convert_seconds_sum` |
| POST | `/convert` | 请求体即 `request.json`；未提供 `output_dir` 时服务分配一次性目录并回收 |

`/convert` 的成功响应体是 `ConvertResult`：

```json
{
  "job_id": "job_01",
  "ok": true,
  "manifest": { /* 见 docs/03 §2.1 */ }
}
```

失败响应 HTTP 状态仍为 200，`ok=false` 且带 `error.code/message/retryable`，方便 host 直接解析错误信封（`CONVERSION_TIMEOUT`、`SOURCE_SHA_MISMATCH` 等）。

## 容器与安全

- `Dockerfile` 基于 `python:3.11-slim-bookworm`；追加 LibreOffice、Noto CJK、Pillow / pydicom / openpyxl 等依赖；`USER converter` uid 10001 非 root。
- 建议使用如下参数运行：`docker run --network=none --read-only --tmpfs /tmp --tmpfs /output ... ghcr.io/xxx/converter:0.0.1`。
- 处理器进程被子进程隔离，`wall_time_seconds` 硬超时会 SIGTERM → SIGKILL；主线程始终能回收目录、返回 `CONVERSION_TIMEOUT`。
- HTML 输出附带固定 CSP meta（`default-src 'none'` + `img-src data:` + `style-src 'unsafe-inline'`），配合 host 侧 `<iframe sandbox="">` 保证浏览器隔离。
- DICOM 输出不写回患者标签；结构化文本处理器拒绝 DTD/外部实体（有 `defusedxml` 时优先使用）。

## 测试

- 17 项 unittest（`tests/`）覆盖 TXT/MD/JSON/CSV/HTML/Notebook/PDF 处理器、SandboxFs 边界、HTTP `/healthz` `/metrics` `/convert` 端到端。
- 缺少 LibreOffice / Pillow / pydicom 时对应 processor 返回 `DEPENDENCY_UNAVAILABLE`，测试跳过其调用路径。
