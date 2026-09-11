from __future__ import annotations

import hashlib
import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

from converter.server import create_server


class ConverterServerTest(unittest.TestCase):
    server = None
    thread: threading.Thread | None = None
    root: tempfile.TemporaryDirectory | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.root = tempfile.TemporaryDirectory(prefix="conv-root-")
        cls.server = create_server(host="127.0.0.1", port=0, output_root=cls.root.name)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.server is not None:
            cls.server.shutdown()
            cls.server.server_close()
        if cls.root is not None:
            cls.root.cleanup()

    @property
    def base_url(self) -> str:
        assert self.server is not None
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def test_healthz(self) -> None:
        with urllib.request.urlopen(f"{self.base_url}/healthz", timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            body = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(body["status"], "ok")

    def test_metrics(self) -> None:
        with urllib.request.urlopen(f"{self.base_url}/metrics", timeout=5) as resp:
            text = resp.read().decode("utf-8")
            self.assertIn("converter_requests_total", text)

    def test_convert_txt_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory(prefix="conv-src-") as tmp:
            src = Path(tmp) / "hello.txt"
            content = "hello 世界".encode("utf-8")
            src.write_bytes(content)
            output = Path(tmp) / "out"
            output.mkdir()
            payload = {
                "contract_version": "1.0",
                "job_id": "job-http",
                "source": {
                    "path": str(src),
                    "extension": "txt",
                    "size_bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                },
                "profile": {"id": "standard-v1", "digest": "d1"},
                "output_dir": str(output),
                "limits": {"wall_time_seconds": 15, "output_bytes": 4 * 1024 * 1024},
            }
            req = urllib.request.Request(
                f"{self.base_url}/convert",
                data=json.dumps(payload).encode("utf-8"),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                self.assertEqual(resp.status, 200)
                body = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(body["ok"], msg=body)
                self.assertEqual(body["manifest"]["default_representation_id"], "rep_text")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
