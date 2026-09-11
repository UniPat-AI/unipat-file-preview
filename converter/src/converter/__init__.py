"""统一转换容器。

对外主要暴露两条入口：
- 命令行：``python -m converter --request /input/request.json``
- HTTP：``converter.server`` 内的 ASGI/BaseHTTPRequestHandler 服务
"""

from .contracts import (  # noqa: F401
    CONTRACT_VERSION,
    ConvertRequest,
    ConvertResult,
    Manifest,
    ManifestArtifact,
    ManifestRepresentation,
    ManifestWarning,
    ProcessorError,
    Coverage,
)
from .errors import (  # noqa: F401
    ERROR_CODES,
    ConverterError,
    format_error_json,
)
from .runtime import (  # noqa: F401
    ProcessorContext,
    build_context_from_request,
    run_processor,
)

__all__ = [
    "CONTRACT_VERSION",
    "ConvertRequest",
    "ConvertResult",
    "Manifest",
    "ManifestArtifact",
    "ManifestRepresentation",
    "ManifestWarning",
    "ProcessorError",
    "Coverage",
    "ERROR_CODES",
    "ConverterError",
    "format_error_json",
    "ProcessorContext",
    "build_context_from_request",
    "run_processor",
]
