# syntax=docker/dockerfile:1.6
FROM python:3.11-slim-bookworm

# 转换镜像声明：LibreOffice + Python + Pillow + pydicom + openpyxl。
# - 非 root 运行，只读根文件系统，`docker run --read-only` 下也可工作。
# - 无网络：项目应在启动容器时 `--network=none`。
# - 挂载：`/input` 只读、`/output` 可写；请求通过 stdin 或 HTTP 传入。

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-core \
        libreoffice-writer \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-draw \
        fonts-dejavu \
        fonts-noto-cjk \
        fonts-noto-cjk-extra \
        fonts-noto-color-emoji \
        libjpeg62-turbo \
        libopenjp2-7 \
        libtiff6 \
        libwebp7 \
        zlib1g \
        libxml2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir . \
    && pip install --no-cache-dir "openpyxl>=3.1" "xlrd==1.2.0" "Pillow>=10.2" "pydicom>=2.4" "numpy>=1.26" "tinycss2>=1.2" "defusedxml>=0.7" "pypdf>=4.0"

RUN useradd --create-home --uid 10001 converter \
    && mkdir -p /input /output \
    && chown -R converter:converter /input /output /app

USER converter

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8081/healthz', timeout=2).status==200 else 1)" || exit 1

# 默认作为 HTTP 服务启动；host 可覆盖为 CLI 单次调用（`python -m converter --request ...`）
CMD ["python", "-m", "converter.server", "--host", "0.0.0.0", "--port", "8081"]
