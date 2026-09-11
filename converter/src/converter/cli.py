"""命令行入口：``python -m converter --request /input/request.json``。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .contracts import ConvertRequest
from .errors import ConverterError, ERROR_CODES
from .runtime import run_processor


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="converter", description="统一转换容器 CLI")
    parser.add_argument("--request", required=True, help="request.json 路径")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        raw = Path(args.request).read_text(encoding="utf-8")
        data = json.loads(raw)
        request = ConvertRequest.from_dict(data)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        payload = {
            "job_id": "",
            "ok": False,
            "error": {
                "code": ERROR_CODES.INVALID_REQUEST,
                "message": str(exc),
                "retryable": False,
            },
        }
        _emit(payload)
        return 2

    result = run_processor(request)
    _emit(result.to_dict())
    return 0 if result.ok else 1


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
