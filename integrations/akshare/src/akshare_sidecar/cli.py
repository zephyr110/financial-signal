"""本地排查用 CLI：直接调用 AKShare，不经过 HTTP 鉴权。"""

from __future__ import annotations

import argparse
import json
import sys

from .errors import UpstreamError, UpstreamSchemaError
from .service import fetch_daily, fetch_limit_pool


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="akshare-sidecar-cli")
    sub = parser.add_subparsers(dest="command", required=True)

    daily = sub.add_parser("daily", help="拉取日线")
    daily.add_argument("--code", required=True)
    daily.add_argument("--start", required=True, help="YYYY-MM-DD")
    daily.add_argument("--end", required=True, help="YYYY-MM-DD")

    pool = sub.add_parser("limit-pool", help="拉取涨停股池")
    pool.add_argument("--trade-date", required=True, help="YYYY-MM-DD")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "daily":
            bars, warnings, provider = fetch_daily(args.code, args.start, args.end)
            payload = {"code": args.code, "provider": provider, "bars": bars, "warnings": warnings}
        else:
            items, warnings = fetch_limit_pool(args.trade_date)
            payload = {"trade_date": args.trade_date, "items": items, "warnings": warnings}
    except (UpstreamError, UpstreamSchemaError) as exc:
        print(f"ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
