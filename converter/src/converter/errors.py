"""稳定错误码与错误响应结构。

命名与 docs/03、docs/04 中出现的错误码保持一致，避免 host/前端再做一次映射。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class ERROR_CODES:
    UNSUPPORTED_EXTENSION = "UNSUPPORTED_EXTENSION"
    INVALID_REQUEST = "INVALID_REQUEST"
    SOURCE_MISSING = "SOURCE_MISSING"
    SOURCE_TOO_LARGE = "SOURCE_TOO_LARGE"
    SOURCE_SHA_MISMATCH = "SOURCE_SHA_MISMATCH"
    PASSWORD_REQUIRED = "PASSWORD_REQUIRED"
    INVALID_CONVERSION_OUTPUT = "INVALID_CONVERSION_OUTPUT"
    CONVERSION_TIMEOUT = "CONVERSION_TIMEOUT"
    RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED"
    OUTPUT_TOO_LARGE = "OUTPUT_TOO_LARGE"
    IMAGE_CODEC_UNSUPPORTED = "IMAGE_CODEC_UNSUPPORTED"
    FONT_SUBSTITUTED = "FONT_SUBSTITUTED"
    ROW_LIMIT_REACHED = "ROW_LIMIT_REACHED"
    COL_LIMIT_REACHED = "COL_LIMIT_REACHED"
    ENCODING_UNCERTAIN = "ENCODING_UNCERTAIN"
    FORMAT_FALLBACK = "FORMAT_FALLBACK"
    RICH_OUTPUT_OMITTED = "RICH_OUTPUT_OMITTED"
    WINDOW_DERIVED = "WINDOW_DERIVED"
    EMBEDDED_CONTENT_UNKNOWN = "EMBEDDED_CONTENT_UNKNOWN"
    HTML_TEXT_FALLBACK = "HTML_TEXT_FALLBACK"
    STYLE_BLOCKED_BY_HOST = "STYLE_BLOCKED_BY_HOST"
    DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE"
    INTERNAL_ERROR = "INTERNAL_ERROR"


@dataclass(frozen=True)
class ConverterError(Exception):
    """转换器抛出的稳定错误。

    - ``retryable``: 是否属于 host 可以自动重试的基础设施类错误。
    - ``details``: 允许结构化数据，禁止放入用户敏感信息（原文件正文、DICOM 患者信息等）。
    """

    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        # dataclass(frozen=True) 与 Exception 需要显式调用父类构造
        Exception.__init__(self, f"{self.code}: {self.message}")


def format_error_json(err: ConverterError) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "code": err.code,
        "message": err.message,
        "retryable": err.retryable,
    }
    if err.details is not None:
        payload["details"] = err.details
    return payload
