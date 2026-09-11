"""HTML 清理：白名单标签/属性 + CSP 固定 meta + data:image 独立解码。

- 只使用标准库的 ``html.parser``；不引入 bs4，避免额外依赖。
- 输出是「不含 script/iframe/form 的受控 HTML 片段」，可直接放入宿主 iframe srcdoc。
"""

from __future__ import annotations

import base64
import html as html_utils
import re
from html.parser import HTMLParser
from typing import Any

from ..contracts import (
    Manifest,
    ManifestArtifact,
    ManifestRepresentation,
    ManifestWarning,
)
from ..errors import ERROR_CODES
from ..runtime import ProcessorContext
from ._common import decode_bytes

_ALLOWED_TAGS = {
    "html", "head", "body", "meta", "title",
    "div", "span", "p", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "b", "strong", "i", "em", "u", "s", "small", "sub", "sup",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
    "a", "img",
    "pre", "code", "blockquote",
    "figure", "figcaption",
}
_SELF_CLOSING = {"br", "hr", "img", "meta", "col"}
_ALLOWED_ATTRS = {
    "*": {"class", "style", "id", "title", "lang"},
    "a": {"href", "target", "rel"},
    "img": {"src", "alt", "width", "height"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
    "meta": {"charset"},
    "col": {"span"},
}

_ALLOWED_STYLE_PROPS = {
    "color", "background-color", "font-size", "font-weight", "font-style", "font-family",
    "text-align", "text-decoration", "line-height",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border", "border-color", "border-style", "border-width",
    "border-top", "border-right", "border-bottom", "border-left",
    "width", "height", "max-width", "max-height",
    "display", "vertical-align", "white-space", "list-style-type",
}

_CSP_META = (
    '<meta http-equiv="Content-Security-Policy" '
    'content="default-src \'none\'; script-src \'none\'; connect-src \'none\'; '
    "img-src data:; style-src 'unsafe-inline'; font-src 'none'; object-src 'none'; "
    "base-uri 'none'; form-action 'none'\">"
)


_VOID_TAGS = {"input", "embed", "param", "source", "track", "wbr", "img", "br", "hr", "meta", "link", "base"}


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.dropped: dict[str, int] = {}
        self._skip_stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._skip_stack:
            return
        if tag in _VOID_TAGS:
            self.dropped[tag] = self.dropped.get(tag, 0) + 1
            if tag in _ALLOWED_TAGS:
                safe_attrs = _filter_attrs(tag, attrs)
                rendered_attrs = "".join(f' {k}="{html_utils.escape(v)}"' for k, v in safe_attrs)
                self.out.append(f"<{tag}{rendered_attrs}>")
            return
        if tag in {"script", "style", "iframe", "object", "form", "button"}:
            self._skip_stack.append(tag)
            self.dropped[tag] = self.dropped.get(tag, 0) + 1
            return
        if tag not in _ALLOWED_TAGS:
            self.dropped[tag] = self.dropped.get(tag, 0) + 1
            return
        safe_attrs = _filter_attrs(tag, attrs)
        rendered_attrs = "".join(f' {k}="{html_utils.escape(v)}"' for k, v in safe_attrs)
        self.out.append(f"<{tag}{rendered_attrs}>")

    def handle_endtag(self, tag: str) -> None:
        if self._skip_stack:
            if self._skip_stack[-1] == tag:
                self._skip_stack.pop()
            return
        if tag in _ALLOWED_TAGS and tag not in _SELF_CLOSING:
            self.out.append(f"</{tag}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._skip_stack:
            return
        if tag in _ALLOWED_TAGS:
            safe_attrs = _filter_attrs(tag, attrs)
            rendered_attrs = "".join(f' {k}="{html_utils.escape(v)}"' for k, v in safe_attrs)
            self.out.append(f"<{tag}{rendered_attrs}/>")

    def handle_data(self, data: str) -> None:
        if self._skip_stack:
            return
        self.out.append(html_utils.escape(data))

    def handle_comment(self, data: str) -> None:  # 移除注释
        return None


def _filter_attrs(
    tag: str, attrs: list[tuple[str, str | None]]
) -> list[tuple[str, str]]:
    allowed_global = _ALLOWED_ATTRS.get("*", set())
    allowed_tag = _ALLOWED_ATTRS.get(tag, set())
    out: list[tuple[str, str]] = []
    for name, value in attrs:
        if value is None:
            continue
        lname = name.lower()
        if lname.startswith("on"):
            continue
        if lname not in allowed_global and lname not in allowed_tag:
            continue
        v = value.strip()
        if lname == "href":
            v = _sanitize_href(v)
            if v is None:
                continue
        if lname == "src":
            v = _sanitize_img_src(v)
            if v is None:
                continue
        if lname == "style":
            v = _sanitize_style(v)
        out.append((lname, v))
    return out


def _sanitize_href(value: str) -> str | None:
    v = value.strip()
    if v.startswith("#"):
        return v
    lower = v.lower()
    if lower.startswith(("http://", "https://", "mailto:")):
        return v
    return None


def _sanitize_img_src(value: str) -> str | None:
    v = value.strip()
    if not v.startswith("data:"):
        return None
    # 允许 data:image/png|jpeg|webp;base64,...；其它形式丢弃
    m = re.match(r"^data:(image/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$", v)
    if not m:
        return None
    try:
        base64.b64decode(m.group(3), validate=True)
    except Exception:
        return None
    return v


def _sanitize_style(value: str) -> str:
    parts = value.split(";")
    kept: list[str] = []
    for part in parts:
        if ":" not in part:
            continue
        k, _, v = part.partition(":")
        k = k.strip().lower()
        v = v.strip()
        if k not in _ALLOWED_STYLE_PROPS:
            continue
        if "url(" in v.lower():
            continue
        kept.append(f"{k}: {v}")
    return "; ".join(kept)


def process(ctx: ProcessorContext) -> Manifest:
    ctx.check_deadline()
    raw = ctx.source_path.read_bytes()
    decoded = decode_bytes(raw)
    parser = _Sanitizer()
    parser.feed(decoded.text)
    parser.close()
    body_html = "".join(parser.out)
    document = (
        "<!DOCTYPE html><html><head>"
        f"{_CSP_META}<meta charset=\"utf-8\">"
        "</head><body>"
        f"{body_html}"
        "</body></html>"
    )
    written = ctx.fs.write_text("html/document.html", document)
    artifacts: list[ManifestArtifact] = [
        ManifestArtifact(
            id="entry",
            path=written.relative_path,
            media_type="text/html; charset=utf-8",
            size_bytes=written.size_bytes,
            sha256=written.sha256,
            role="entry",
        )
    ]
    warnings: list[ManifestWarning] = []
    if parser.dropped:
        warnings.append(
            ManifestWarning(
                code=ERROR_CODES.HTML_TEXT_FALLBACK,
                message=(
                    "移除了不安全元素/属性："
                    + ", ".join(f"{k}×{v}" for k, v in parser.dropped.items())
                ),
            )
        )

    rep = ManifestRepresentation(
        id="rep_html",
        kind="html",
        label="网页",
        status="ready",
        completeness="complete" if not parser.dropped else "partial",
        affects_completeness=True,
        entry_artifact="entry",
        warnings=warnings,
    )
    return Manifest(
        schema_version="1.0",
        profile_id=ctx.profile_id,
        availability="ready" if not parser.dropped else "partial",
        default_representation_id="rep_html",
        representations=[rep],
        artifacts=artifacts,
        capabilities={
            "search_scope": "loaded_html",
            "static_only": True,
            "sandboxed": True,
        },
        warnings=warnings,
    )


__all__ = ["process"]
