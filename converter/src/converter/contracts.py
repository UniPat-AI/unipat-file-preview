"""转换器的公共数据结构与 request/result 校验。

保持与 docs/03 §2 的公开清单结构对齐；处理器只写出「候选清单」，最终 `artifact_id`
的分配由 host 完成。这里用简单 dataclass + 手写校验，避免引入 pydantic。
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Literal

CONTRACT_VERSION = "1.0"

Kind = Literal[
    "pdf",
    "table",
    "image_gallery",
    "html",
    "notebook",
    "structured_text",
    "plain_text",
]

Availability = Literal["ready", "partial", "none"]
Status = Literal["ready", "failed", "skipped"]
Completeness = Literal["complete", "partial", "unknown"]


@dataclass
class ManifestWarning:
    code: str
    message: str
    scope: str | None = None


@dataclass
class ProcessorError:
    code: str
    message: str
    retryable: bool = False


@dataclass
class Coverage:
    unit: str
    shown: int
    total: int | None
    scope: str | None = None


@dataclass
class ManifestArtifact:
    """候选清单中的产物。

    path 是相对 ``output_dir`` 的相对路径，禁止 ``..``、绝对路径或软链接。
    ``role`` 通常包括 ``entry`` / ``chunk`` / ``thumbnail`` / ``derived``。
    """

    path: str
    media_type: str
    size_bytes: int
    sha256: str
    role: str = "entry"
    id: str | None = None  # 处理器自定义的稳定引用；host 会重映射为不透明 artifact_id


@dataclass
class ManifestRepresentation:
    id: str
    kind: Kind
    label: str
    status: Status
    completeness: Completeness = "complete"
    affects_completeness: bool = True
    entry_artifact: str | None = None
    coverage: Coverage | None = None
    warnings: list[ManifestWarning] = field(default_factory=list)
    error: ProcessorError | None = None


@dataclass
class Manifest:
    """候选清单（processor 输出，写入 result.json）。"""

    schema_version: str
    profile_id: str
    availability: Availability
    default_representation_id: str | None
    representations: list[ManifestRepresentation]
    artifacts: list[ManifestArtifact]
    capabilities: dict[str, Any] = field(default_factory=dict)
    warnings: list[ManifestWarning] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return _clean_dict(asdict(self))


@dataclass(frozen=True)
class SourceInfo:
    path: str
    extension: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class ProfileInfo:
    id: str
    digest: str


@dataclass(frozen=True)
class Limits:
    wall_time_seconds: int = 480
    output_bytes: int = 2 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class ConvertRequest:
    contract_version: str
    job_id: str
    source: SourceInfo
    profile: ProfileInfo
    output_dir: str
    limits: Limits

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ConvertRequest":
        _require_string(data, "contract_version")
        if data["contract_version"] != CONTRACT_VERSION:
            raise ValueError(
                f"contract_version 不兼容：期望 {CONTRACT_VERSION}，收到 {data['contract_version']}"
            )
        _require_string(data, "job_id")
        _require_string(data, "output_dir")
        source = data.get("source") or {}
        _require_string(source, "path")
        _require_string(source, "extension")
        if not isinstance(source.get("size_bytes"), int):
            raise ValueError("source.size_bytes 必须为整数")
        _require_string(source, "sha256")
        profile = data.get("profile") or {}
        _require_string(profile, "id")
        _require_string(profile, "digest")
        limits_dict = data.get("limits") or {}
        wall = int(limits_dict.get("wall_time_seconds", 480))
        out_bytes = int(limits_dict.get("output_bytes", 2 * 1024 * 1024 * 1024))
        return ConvertRequest(
            contract_version=data["contract_version"],
            job_id=data["job_id"],
            source=SourceInfo(
                path=source["path"],
                extension=source["extension"].lower(),
                size_bytes=int(source["size_bytes"]),
                sha256=source["sha256"].lower(),
            ),
            profile=ProfileInfo(id=profile["id"], digest=profile["digest"]),
            output_dir=data["output_dir"],
            limits=Limits(wall_time_seconds=wall, output_bytes=out_bytes),
        )


@dataclass
class ConvertResult:
    """一次转换的最终返回体（同时也是写到 result.json 的内容）。"""

    job_id: str
    ok: bool
    manifest: Manifest | None = None
    error: ProcessorError | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"job_id": self.job_id, "ok": self.ok}
        if self.manifest is not None:
            payload["manifest"] = self.manifest.to_dict()
        if self.error is not None:
            payload["error"] = asdict(self.error)
        return payload


def _require_string(container: dict[str, Any], key: str) -> None:
    v = container.get(key)
    if not isinstance(v, str) or not v:
        raise ValueError(f"字段 {key} 必须为非空字符串")


def _clean_dict(value: Any) -> Any:
    """把 asdict 得到的 None 字段清理掉，保持公开清单更清爽。"""
    if isinstance(value, dict):
        return {k: _clean_dict(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_clean_dict(v) for v in value]
    return value


def sum_artifact_bytes(items: Iterable[ManifestArtifact]) -> int:
    return sum(int(a.size_bytes) for a in items)
