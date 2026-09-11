"""HTTP 服务：``/convert``、``/healthz``、``/metrics``。

采用 stdlib ``http.server``，避免引入 Flask/FastAPI 依赖。设计要点：
- 每个 ``/convert`` 请求都在独立子进程里执行处理器（``multiprocessing.Process``），
  以便硬性 wall-time 超时；主进程负责回收目录、聚合结果。
- ``request.json`` 从请求体读取；``source`` 由调用方（host）自行放置到只读输入目录，
  转换器不主动下载外部资源。
- 服务本身无状态；``/metrics`` 输出 Prometheus 文本格式的简易计数器。
"""

from __future__ import annotations

import json
import logging
import multiprocessing as mp
import os
import queue
import shutil
import signal
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from .contracts import ConvertRequest
from .errors import ERROR_CODES, ConverterError, format_error_json
from .runtime import run_processor

_log = logging.getLogger("converter.server")


@dataclass
class Metrics:
    started_at: float
    requests_total: int = 0
    requests_ok: int = 0
    requests_failed: int = 0
    requests_timeout: int = 0
    convert_seconds_sum: float = 0.0

    def render_prometheus(self) -> str:
        now = time.time()
        uptime = now - self.started_at
        lines = [
            "# HELP converter_requests_total Total /convert requests.",
            "# TYPE converter_requests_total counter",
            f"converter_requests_total {self.requests_total}",
            "# HELP converter_requests_ok_total Successful /convert requests.",
            "# TYPE converter_requests_ok_total counter",
            f"converter_requests_ok_total {self.requests_ok}",
            "# HELP converter_requests_failed_total Failed /convert requests.",
            "# TYPE converter_requests_failed_total counter",
            f"converter_requests_failed_total {self.requests_failed}",
            "# HELP converter_requests_timeout_total /convert timeouts.",
            "# TYPE converter_requests_timeout_total counter",
            f"converter_requests_timeout_total {self.requests_timeout}",
            "# HELP converter_convert_seconds_sum Total processing seconds.",
            "# TYPE converter_convert_seconds_sum counter",
            f"converter_convert_seconds_sum {self.convert_seconds_sum:.6f}",
            "# HELP converter_uptime_seconds Uptime.",
            "# TYPE converter_uptime_seconds gauge",
            f"converter_uptime_seconds {uptime:.3f}",
        ]
        return "\n".join(lines) + "\n"


def _worker_entry(payload: dict[str, Any], result_queue: "mp.Queue[dict[str, Any]]") -> None:
    """子进程入口：解析请求 → 执行 → 把结果 push 回主进程。"""
    try:
        request = ConvertRequest.from_dict(payload)
    except ValueError as exc:
        result_queue.put(
            {
                "job_id": payload.get("job_id", ""),
                "ok": False,
                "error": {
                    "code": ERROR_CODES.INVALID_REQUEST,
                    "message": str(exc),
                    "retryable": False,
                },
            }
        )
        return
    result = run_processor(request)
    result_queue.put(result.to_dict())


class ConverterHandler(BaseHTTPRequestHandler):
    server_version = "unipat-converter/0.0.1"

    # 关联的运行时对象由 factory 注入
    metrics: Metrics
    default_root_dir: str
    hard_timeout_grace_seconds: float

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        _log.info("%s - %s", self.address_string(), format % args)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self._json(200, {"status": "ok", "uptime_seconds": time.time() - self.metrics.started_at})
            return
        if parsed.path == "/metrics":
            self._raw(200, self.metrics.render_prometheus(), "text/plain; version=0.0.4")
            return
        self._json(404, {"code": "NOT_FOUND", "message": self.path})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/convert":
            self._json(404, {"code": "NOT_FOUND", "message": self.path})
            return
        length = int(self.headers.get("content-length", "0") or "0")
        if length <= 0 or length > 4 * 1024 * 1024:
            self._json(
                400,
                {
                    "code": ERROR_CODES.INVALID_REQUEST,
                    "message": "请求体必须为非空 JSON 且不超过 4 MiB",
                },
            )
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._json(
                400,
                {
                    "code": ERROR_CODES.INVALID_REQUEST,
                    "message": f"JSON 解析失败：{exc}",
                },
            )
            return

        # output_dir 允许调用方指定；若未指定，则由服务分配一次性目录并回收
        managed_output = False
        if not payload.get("output_dir"):
            managed_output = True
            payload["output_dir"] = tempfile.mkdtemp(
                prefix="conv-", dir=self.default_root_dir
            )

        wall = int((payload.get("limits") or {}).get("wall_time_seconds", 480))
        started = time.monotonic()

        result_queue: "mp.Queue[dict[str, Any]]" = mp.Queue(maxsize=1)
        process = mp.Process(
            target=_worker_entry, args=(payload, result_queue), daemon=True
        )
        process.start()
        try:
            result = _wait_for_result(
                process,
                result_queue,
                timeout=wall + self.hard_timeout_grace_seconds,
            )
        except TimeoutError:
            self.metrics.requests_timeout += 1
            _terminate_process(process)
            self._json(
                504,
                {
                    "code": ERROR_CODES.CONVERSION_TIMEOUT,
                    "message": f"超过 {wall}s 未返回",
                    "retryable": True,
                },
            )
            if managed_output:
                shutil.rmtree(payload["output_dir"], ignore_errors=True)
            return
        finally:
            elapsed = time.monotonic() - started
            self.metrics.convert_seconds_sum += elapsed
            self.metrics.requests_total += 1

        if result.get("ok"):
            self.metrics.requests_ok += 1
            status = 200
        else:
            self.metrics.requests_failed += 1
            status = 200  # 处理器错误经 JSON 返回，HTTP 层不代表业务失败
        self._json(status, result)
        # 若是托管目录，成功后不清理，让 host 抓取产物；失败也保留供诊断
        if managed_output and not result.get("ok"):
            # 失败留 60s 供诊断，超时由 host 端整体回收
            threading.Timer(
                60.0,
                lambda: shutil.rmtree(payload["output_dir"], ignore_errors=True),
            ).start()

    # -----------------------------
    # helpers
    # -----------------------------
    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _raw(self, status: int, body: str, content_type: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def _wait_for_result(
    process: mp.Process,
    result_queue: "mp.Queue[dict[str, Any]]",
    *,
    timeout: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return result_queue.get(timeout=0.5)
        except queue.Empty:
            if not process.is_alive():
                # 子进程已经退出但队列没写入 → 视为异常
                return {
                    "job_id": "",
                    "ok": False,
                    "error": {
                        "code": ERROR_CODES.INTERNAL_ERROR,
                        "message": "worker exited without result",
                        "retryable": True,
                    },
                }
    raise TimeoutError("wait_for_result timeout")


def _terminate_process(process: mp.Process) -> None:
    if not process.is_alive():
        return
    try:
        os.kill(process.pid or 0, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):  # pragma: no cover
        return
    process.join(timeout=2.0)
    if process.is_alive():
        try:
            os.kill(process.pid or 0, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):  # pragma: no cover
            return
        process.join(timeout=2.0)


def create_server(
    *,
    host: str = "0.0.0.0",
    port: int = 8081,
    output_root: Optional[str] = None,
    hard_timeout_grace_seconds: float = 15.0,
) -> ThreadingHTTPServer:
    metrics = Metrics(started_at=time.time())
    root_dir = output_root or tempfile.mkdtemp(prefix="converter-root-")

    class _BoundHandler(ConverterHandler):
        pass

    _BoundHandler.metrics = metrics
    _BoundHandler.default_root_dir = root_dir
    _BoundHandler.hard_timeout_grace_seconds = hard_timeout_grace_seconds

    server = ThreadingHTTPServer((host, port), _BoundHandler)
    server.daemon_threads = True
    server.allow_reuse_address = True
    return server


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser("converter-server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument("--output-root", default=None, help="托管输出目录的父路径")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    server = create_server(host=args.host, port=args.port, output_root=args.output_root)
    _log.info("converter-server listening on %s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover
        _log.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
