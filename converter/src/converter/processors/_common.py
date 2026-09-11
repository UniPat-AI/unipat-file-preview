"""处理器共享的通用工具：编码探测、UTF-8 归一化、chunk 切块。"""

from __future__ import annotations

import codecs
from dataclasses import dataclass


@dataclass
class DecodedText:
    text: str
    encoding: str
    uncertain: bool
    replaced: bool


_BOMS: tuple[tuple[bytes, str], ...] = (
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF16_LE, "utf-16-le"),
    (codecs.BOM_UTF16_BE, "utf-16-be"),
)


def decode_bytes(data: bytes, *, prefer: str | None = None) -> DecodedText:
    """按受限候选顺序解码文本。

    - 优先按 BOM；
    - 其次按 ``prefer``；
    - 最后回退到 utf-8（严格）→ utf-8（替换）→ gbk（替换）；
    - 使用替换字符时 ``replaced=True``、``uncertain=True``。
    """

    for bom, enc in _BOMS:
        if data.startswith(bom):
            return DecodedText(
                text=data.decode(enc, errors="replace"),
                encoding=enc,
                uncertain=False,
                replaced=False,
            )
    candidates = [c for c in (prefer, "utf-8", "gb18030") if c]
    for enc in candidates:
        try:
            return DecodedText(
                text=data.decode(enc, errors="strict"),
                encoding="gbk" if enc == "gb18030" else enc,
                uncertain=False,
                replaced=False,
            )
        except UnicodeDecodeError:
            continue
    # 检查是否有无 BOM 的 UTF-16 特征（偶数字节且包含多个 \x00）
    if len(data) >= 2 and len(data) % 2 == 0 and b"\x00" in data:
        try:
            return DecodedText(
                text=data.decode("utf-16", errors="strict"),
                encoding="utf-16",
                uncertain=True,
                replaced=False,
            )
        except UnicodeDecodeError:
            pass
    return DecodedText(
        text=data.decode("utf-8", errors="replace"),
        encoding="utf-8",
        uncertain=True,
        replaced=True,
    )


def chunk_text(text: str, *, chunk_bytes: int = 256 * 1024) -> list[str]:
    """按完整 Unicode 字符边界切成 <= ``chunk_bytes`` 的 UTF-8 chunk。"""
    out: list[str] = []
    buf: list[str] = []
    size = 0
    for ch in text:
        b = len(ch.encode("utf-8"))
        if size + b > chunk_bytes and buf:
            out.append("".join(buf))
            buf = []
            size = 0
        buf.append(ch)
        size += b
    if buf:
        out.append("".join(buf))
    return out


def clamp_text(text: str, *, max_bytes: int = 10 * 1024 * 1024) -> tuple[str, bool]:
    """把文本裁剪到不超过 max_bytes UTF-8 字节，按字符边界截断。"""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text, False
    # 按字符累加，避免中间截断多字节字符
    total = 0
    for i, ch in enumerate(text):
        total += len(ch.encode("utf-8"))
        if total > max_bytes:
            return text[:i], True
    return text, False
