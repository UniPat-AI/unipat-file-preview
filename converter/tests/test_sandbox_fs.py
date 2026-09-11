from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from converter.errors import ERROR_CODES
from converter.sandbox_fs import SandboxFs


class SandboxFsTest(unittest.TestCase):
    def test_write_bytes_and_sha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fs = SandboxFs(tmp, budget_bytes=1024)
            written = fs.write_bytes("a/b/c.txt", b"hello")
            self.assertEqual(written.size_bytes, 5)
            self.assertEqual(
                written.sha256,
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            )
            self.assertEqual(fs.used_bytes, 5)
            self.assertTrue((Path(tmp) / "a" / "b" / "c.txt").exists())

    def test_reject_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fs = SandboxFs(tmp, budget_bytes=1024)
            with self.assertRaises(Exception) as ctx:
                fs.write_bytes("../evil.txt", b"x")
            self.assertIn(ERROR_CODES.INVALID_REQUEST, str(ctx.exception))

    def test_budget_exceeded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fs = SandboxFs(tmp, budget_bytes=3)
            with self.assertRaises(Exception) as ctx:
                fs.write_bytes("big.txt", b"1234")
            self.assertIn(ERROR_CODES.OUTPUT_TOO_LARGE, str(ctx.exception))

    def test_reject_absolute_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fs = SandboxFs(tmp, budget_bytes=1024)
            with self.assertRaises(Exception) as ctx:
                fs.write_bytes("/absolute", b"x")
            self.assertIn(ERROR_CODES.INVALID_REQUEST, str(ctx.exception))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
