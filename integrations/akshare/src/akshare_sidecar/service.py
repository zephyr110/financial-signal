"""AKShare 调用包装：串行、限速并做一次重试，避免触发上游限流。"""

from __future__ import annotations

import logging
import os
import threading
import time
from importlib import metadata
from typing import Any

from .codes import normalize_stock_code, symbol_of
from .errors import UpstreamError
from .normalize import (
    normalize_daily_frame,
    normalize_limit_pool_frame,
    normalize_sina_daily_frame,
)

logger = logging.getLogger("akshare_sidecar")
_CALL_LOCK = threading.Lock()
_ERROR_LIMIT = 300
_LAST_CALL_AT = 0.0
_MIN_INTERVAL_SECONDS = 1.2
_RETRY_DELAY_SECONDS = 1.0
_ATTEMPTS = 2
_SOURCE_COOLDOWN_SECONDS = 600.0
_EASTMONEY_BLOCKED_UNTIL = 0.0


def akshare_version() -> str | None:
    try:
        return metadata.version("akshare")
    except metadata.PackageNotFoundError:
        return None


def _akshare():
    try:
        import akshare as ak
    except Exception as exc:  # noqa: BLE001 - 安装问题要原样暴露给运维
        raise UpstreamError(f"AKShare 导入失败: {type(exc).__name__}: {str(exc)[:_ERROR_LIMIT]}") from exc
    return ak


def _env_seconds(name: str, default: float) -> float:
    try:
        return max(float(os.environ.get(name, default)), 0.0)
    except ValueError:
        return default


def _call(label: str, fn, **kwargs):
    global _LAST_CALL_AT
    min_interval = _env_seconds("AKSHARE_MIN_INTERVAL_SECONDS", _MIN_INTERVAL_SECONDS)
    retry_delay = _env_seconds("AKSHARE_RETRY_DELAY_SECONDS", _RETRY_DELAY_SECONDS)
    last_exc: Exception | None = None

    for attempt in range(1, _ATTEMPTS + 1):
        try:
            with _CALL_LOCK:
                wait = min_interval - (time.monotonic() - _LAST_CALL_AT)
                if wait > 0:
                    time.sleep(wait)
                try:
                    return fn(**kwargs)
                finally:
                    _LAST_CALL_AT = time.monotonic()
        except Exception as exc:  # noqa: BLE001 - 上游异常类型不稳定
            last_exc = exc
            if attempt < _ATTEMPTS:
                logger.warning("%s第 %s 次失败，%.1fs 后重试: %s", label, attempt, retry_delay, type(exc).__name__)
                time.sleep(retry_delay)

    detail = str(last_exc)[:_ERROR_LIMIT]
    raise UpstreamError(
        f"{label}调用失败: {type(last_exc).__name__}: {detail}"
    ) from last_exc


def _eastmoney_daily(normalized: str, start: str, end: str) -> list[dict[str, Any]]:
    ak = _akshare()
    frame = _call(
        "AKShare 东财日线",
        ak.stock_zh_a_hist,
        symbol=symbol_of(normalized),
        period="daily",
        start_date=start.replace("-", ""),
        end_date=end.replace("-", ""),
        adjust="",
    )
    return normalize_daily_frame(frame, normalized)


def _sina_daily(normalized: str, start: str, end: str) -> list[dict[str, Any]]:
    ak = _akshare()
    suffix = normalized.split(".")[1].lower()
    frame = _call(
        "AKShare 新浪日线",
        ak.stock_zh_a_daily,
        symbol=f"{suffix}{symbol_of(normalized)}",
        start_date=start.replace("-", ""),
        end_date=end.replace("-", ""),
        adjust="",
    )
    return normalize_sina_daily_frame(frame, normalized)


def fetch_daily(
    code: str, start: str, end: str
) -> tuple[list[dict[str, Any]], list[str], str]:
    global _EASTMONEY_BLOCKED_UNTIL
    normalized = normalize_stock_code(code)
    warnings: list[str] = []
    provider = "sina"
    bars: list[dict[str, Any]] | None = None
    cooldown = _env_seconds("AKSHARE_SOURCE_COOLDOWN_SECONDS", _SOURCE_COOLDOWN_SECONDS)

    if time.monotonic() >= _EASTMONEY_BLOCKED_UNTIL:
        try:
            bars = _eastmoney_daily(normalized, start, end)
            provider = "eastmoney"
            _EASTMONEY_BLOCKED_UNTIL = 0.0
        except UpstreamError as exc:
            _EASTMONEY_BLOCKED_UNTIL = time.monotonic() + cooldown
            warnings.append(f"东方财富日线不可用，已回退到新浪：{str(exc)[:_ERROR_LIMIT]}")
    else:
        warnings.append("东方财富日线暂时冷却中，直接使用新浪")

    if bars is None:
        try:
            bars = _sina_daily(normalized, start, end)
        except UpstreamError as exc:
            raise UpstreamError(
                f"东方财富与新浪日线均失败：{warnings[-1] if warnings else ''}；{exc}"
            ) from exc

    if not bars:
        warnings.append(f"{normalized} 在 {start} 至 {end} 无日线数据（非交易日、停牌或上游尚未更新）")
    return bars, warnings, provider


def fetch_limit_pool(trade_date: str) -> tuple[list[dict[str, Any]], list[str]]:
    ak = _akshare()
    frame = _call(
        "AKShare 涨停股池",
        ak.stock_zt_pool_em,
        date=trade_date.replace("-", ""),
    )
    items = normalize_limit_pool_frame(frame)
    warnings = (
        []
        if items
        else [f"{trade_date} 涨停股池为空：可能非交易日、尚未更新，或确实无涨停"]
    )
    return items, warnings
