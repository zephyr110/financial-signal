"""只读 HTTP 侧车：Bearer 鉴权，默认仅绑定回环地址。"""

from __future__ import annotations

import logging
import os
import secrets
from datetime import date, datetime, timezone
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

from . import __version__
from .codes import InvalidCode, normalize_stock_code
from .errors import UpstreamError, UpstreamSchemaError
from .service import akshare_version, fetch_daily, fetch_limit_pool

logger = logging.getLogger("akshare_sidecar")

app = FastAPI(
    title="AKShare sidecar",
    version=__version__,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def require_token(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get("AKSHARE_SIDECAR_TOKEN", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="AKSHARE_SIDECAR_TOKEN 未配置")
    supplied = ""
    if authorization and authorization.startswith("Bearer "):
        supplied = authorization[7:].strip()
    # 按字节比较，token 含非 ASCII 时 compare_digest 也不会抛错。
    if not supplied or not secrets.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Bearer token 无效")


def _source(upstream: str = "eastmoney") -> dict[str, Any]:
    return {
        "id": "akshare",
        "name": "AKShare",
        "tier": 2,
        "upstream": upstream,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.exception_handler(UpstreamSchemaError)
async def schema_error_handler(_request, exc: UpstreamSchemaError):
    logger.error("上游数据结构变化: %s", exc)
    return JSONResponse(
        status_code=502,
        content={"error": {"code": "UPSTREAM_SCHEMA", "message": str(exc)}},
    )


@app.exception_handler(UpstreamError)
async def upstream_error_handler(_request, exc: UpstreamError):
    logger.error("上游调用失败: %s", exc)
    return JSONResponse(
        status_code=502,
        content={"error": {"code": "UPSTREAM_FAILED", "message": str(exc)}},
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "akshare-sidecar",
        "version": __version__,
        "akshare": akshare_version(),
        "token_configured": bool(os.environ.get("AKSHARE_SIDECAR_TOKEN", "").strip()),
    }


@app.get("/v1/daily", dependencies=[Depends(require_token)])
def daily(
    code: str = Query(min_length=6, max_length=9),
    start: date = Query(),
    end: date = Query(),
    adjust: str = Query(default="none"),
) -> dict[str, Any]:
    if adjust != "none":
        raise HTTPException(status_code=400, detail="当前只提供不复权日线（adjust=none）")
    if start > end:
        raise HTTPException(status_code=400, detail="start 不能晚于 end")
    if (end - start).days > 366:
        raise HTTPException(status_code=400, detail="单次查询窗口不能超过 366 天")
    try:
        normalized = normalize_stock_code(code)
    except InvalidCode as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    bars, warnings, provider = fetch_daily(normalized, start.isoformat(), end.isoformat())
    return {
        "code": normalized,
        "adjust": "none",
        "provider": provider,
        "bars": bars,
        "warnings": warnings,
        "latest_trade_date": bars[-1]["trade_date"] if bars else None,
        "source": _source(provider),
    }


@app.get("/v1/limit-pool", dependencies=[Depends(require_token)])
def limit_pool(trade_date: date = Query()) -> dict[str, Any]:
    items, warnings = fetch_limit_pool(trade_date.isoformat())
    return {
        "trade_date": trade_date.isoformat(),
        "items": items,
        "warnings": warnings,
        "source": _source(),
    }


def main() -> None:
    host = os.environ.get("AKSHARE_SIDECAR_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port_text = os.environ.get("AKSHARE_SIDECAR_PORT", "8765").strip() or "8765"
    try:
        port = int(port_text)
    except ValueError as exc:
        raise SystemExit("AKSHARE_SIDECAR_PORT 必须是整数") from exc

    if host not in {"127.0.0.1", "::1", "localhost"} and os.environ.get("AKSHARE_ALLOW_NETWORK") != "1":
        raise SystemExit("侧车默认只允许绑定回环地址；确需内网访问请设置 AKSHARE_ALLOW_NETWORK=1")
    if not os.environ.get("AKSHARE_SIDECAR_TOKEN", "").strip():
        raise SystemExit("请先设置 AKSHARE_SIDECAR_TOKEN，再启动侧车")

    uvicorn.run(
        "akshare_sidecar.app:app",
        host=host,
        port=port,
        log_level="info",
        access_log=True,
    )
