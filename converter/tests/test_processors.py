from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from converter.contracts import ConvertRequest
from converter.errors import ERROR_CODES
from converter.runtime import run_processor


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _make_request(
    tmp: Path, name: str, data: bytes, extension: str
) -> tuple[dict, Path, Path]:
    src = tmp / name
    src.write_bytes(data)
    output = tmp / f"out-{name}"
    output.mkdir()
    request = {
        "contract_version": "1.0",
        "job_id": f"job-{name}",
        "source": {
            "path": str(src),
            "extension": extension,
            "size_bytes": len(data),
            "sha256": _sha256_bytes(data),
        },
        "profile": {"id": "standard-v1", "digest": "d1"},
        "output_dir": str(output),
        "limits": {"wall_time_seconds": 20, "output_bytes": 32 * 1024 * 1024},
    }
    return request, src, output


class PlainTextProcessorTest(unittest.TestCase):
    def test_txt_success_with_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            content = ("你好，世界。\n" * 20).encode("utf-8")
            payload, _src, output = _make_request(tmp_p, "hello.txt", content, "txt")
            req = ConvertRequest.from_dict(payload)
            result = run_processor(req)
            self.assertTrue(result.ok, msg=result.to_dict())
            manifest = result.manifest
            self.assertIsNotNone(manifest)
            self.assertEqual(manifest.default_representation_id, "rep_text")  # type: ignore[union-attr]
            entry = next(a for a in manifest.artifacts if a.role == "entry")  # type: ignore[union-attr]
            entry_path = output / entry.path
            self.assertTrue(entry_path.exists())
            payload_read = json.loads(entry_path.read_text("utf-8"))
            self.assertGreaterEqual(payload_read["total_chars"], 20)

    def test_sha_mismatch_reports_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            content = b"abc"
            payload, _src, _output = _make_request(
                tmp_p, "bad.txt", content, "txt"
            )
            payload["source"]["sha256"] = "0" * 64
            req = ConvertRequest.from_dict(payload)
            result = run_processor(req)
            self.assertFalse(result.ok)
            self.assertEqual(result.error.code, ERROR_CODES.SOURCE_SHA_MISMATCH)  # type: ignore[union-attr]


class JsonProcessorTest(unittest.TestCase):
    def test_valid_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            data = json.dumps({"a": 1, "b": [1, 2, 3]}).encode("utf-8")
            payload, _src, output = _make_request(tmp_p, "data.json", data, "json")
            result = run_processor(ConvertRequest.from_dict(payload))
            self.assertTrue(result.ok)
            entry = next(a for a in result.manifest.artifacts if a.role == "entry")  # type: ignore[union-attr]
            payload_read = json.loads((output / entry.path).read_text("utf-8"))
            self.assertTrue(payload_read["is_valid"])

    def test_invalid_json_falls_back_to_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            payload, _src, output = _make_request(
                tmp_p, "bad.json", b"{not: 'json'", "json"
            )
            result = run_processor(ConvertRequest.from_dict(payload))
            self.assertTrue(result.ok)
            warnings = result.manifest.warnings  # type: ignore[union-attr]
            self.assertTrue(any(w.code == ERROR_CODES.FORMAT_FALLBACK for w in warnings))


class CsvProcessorTest(unittest.TestCase):
    def test_csv_produces_workbook_and_chunk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            content = "a,b,c\n1,2,3\n4,5,6\n".encode("utf-8")
            payload, _src, output = _make_request(tmp_p, "t.csv", content, "csv")
            result = run_processor(ConvertRequest.from_dict(payload))
            self.assertTrue(result.ok)
            entry = next(a for a in result.manifest.artifacts if a.role == "entry")  # type: ignore[union-attr]
            workbook = json.loads((output / entry.path).read_text("utf-8"))
            self.assertEqual(workbook["sheets"][0]["row_count"], 3)
            chunks = [a for a in result.manifest.artifacts if a.role == "chunk"]  # type: ignore[union-attr]
            self.assertEqual(len(chunks), 1)


class HtmlProcessorTest(unittest.TestCase):
    def test_script_stripped_and_csp_injected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            content = "<html><body>甲<script>alert(1)</script>乙</body></html>".encode("utf-8")
            payload, _src, output = _make_request(tmp_p, "p.html", content, "html")
            result = run_processor(ConvertRequest.from_dict(payload))
            self.assertTrue(result.ok)
            entry = next(a for a in result.manifest.artifacts if a.role == "entry")  # type: ignore[union-attr]
            html = (output / entry.path).read_text("utf-8")
            self.assertIn("Content-Security-Policy", html)
            self.assertNotIn("<script", html)
            self.assertIn("甲", html)
            self.assertIn("乙", html)


class NotebookProcessorTest(unittest.TestCase):
    def test_omits_rich_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            nb = {
                "cells": [
                    {"cell_type": "markdown", "source": "# 标题"},
                    {
                        "cell_type": "code",
                        "source": "print(1)",
                        "outputs": [
                            {"output_type": "stream", "name": "stdout", "text": "1\n"},
                            {
                                "output_type": "display_data",
                                "data": {"text/plain": "<Figure>", "image/png": "..."},
                            },
                        ],
                    },
                ]
            }
            data = json.dumps(nb).encode("utf-8")
            payload, _src, output = _make_request(tmp_p, "nb.ipynb", data, "ipynb")
            result = run_processor(ConvertRequest.from_dict(payload))
            self.assertTrue(result.ok, msg=result.to_dict())
            warnings = result.manifest.warnings  # type: ignore[union-attr]
            self.assertTrue(any(w.code == ERROR_CODES.RICH_OUTPUT_OMITTED for w in warnings))


class PdfProcessorTest(unittest.TestCase):
    def test_minimal_pdf_ok(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            pdf = _minimal_pdf_bytes()
            payload, _src, output = _make_request(tmp_p, "a.pdf", pdf, "pdf")
            result = run_processor(ConvertRequest.from_dict(payload))
            self.assertTrue(result.ok, msg=result.to_dict())
            entry = next(a for a in result.manifest.artifacts if a.role == "entry")  # type: ignore[union-attr]
            self.assertTrue((output / entry.path).exists())

    def test_missing_pdf_header_is_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            payload, _src, _out = _make_request(tmp_p, "b.pdf", b"not a pdf", "pdf")
            result = run_processor(ConvertRequest.from_dict(payload))
            self.assertFalse(result.ok)
            self.assertEqual(result.error.code, ERROR_CODES.INVALID_CONVERSION_OUTPUT)  # type: ignore[union-attr]


class UnsupportedExtensionTest(unittest.TestCase):
    def test_unknown_ext(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            payload, _src, _out = _make_request(tmp_p, "u.bin", b"1234", "bin")
            result = run_processor(ConvertRequest.from_dict(payload))
            self.assertFalse(result.ok)
            self.assertEqual(result.error.code, ERROR_CODES.UNSUPPORTED_EXTENSION)  # type: ignore[union-attr]


def _minimal_pdf_bytes() -> bytes:
    import io
    from pypdf import PdfWriter
    w = PdfWriter()
    w.add_blank_page(width=100, height=100)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
