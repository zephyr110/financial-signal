"""把 AKShare 的中文 DataFrame 转成稳定的 JSON 口径。

成交量统一为「股」（东财日线给的是手，×100；新浪已经是股）；
成交额统一为「元」；日期统一为 YYYY-MM-DD。
"""

from __future__ import annotations

import math
import re
from typing import Any

import pandas as pd

from .codes import InvalidCode, normalize_stock_code
from .errors import UpstreamSchemaError

_EM_DAILY_FIELDS = {
    "date": "日期",
    "open": "开盘",
    "high": "最高",
    "low": "最低",
    "close": "收盘",
    "volume": "成交量",
    "amount": "成交额",
}
_SINA_DAILY_FIELDS = {
    "date": "date",
    "open": "open",
    "high": "high",
    "low": "low",
    "close": "close",
    "volume": "volume",
    "amount": "amount",
}
_LIMIT_REQUIRED = ("代码", "名称")


def _text(value: Any) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    return str(value).strip()


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _positive(value: Any) -> float | None:
    number = _number(value)
    return number if number is not None and number > 0 else None


def _integer(value: Any) -> int | None:
    number = _number(value)
    return int(round(number)) if number is not None and number >= 0 else None


def _date(value: Any) -> str | None:
    text = _text(value)
    if re.fullmatch(r"\d{8}", text):
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    return match.group(0) if match else None


def _clock(value: Any) -> str | None:
    text = _text(value)
    if re.fullmatch(r"\d{6}", text):
        return f"{text[:2]}:{text[2:4]}:{text[4:]}"
    if re.fullmatch(r"\d{2}:\d{2}:\d{2}", text):
        return text
    if re.fullmatch(r"\d{2}:\d{2}", text):
        return f"{text}:00"
    return None


def _records(frame: pd.DataFrame | None) -> list[dict[str, Any]]:
    if frame is None or frame.empty:
        return []
    return frame.to_dict("records")


def _require(frame: pd.DataFrame, columns: tuple[str, ...], label: str) -> None:
    missing = [column for column in columns if column not in frame.columns]
    if missing:
        actual = ", ".join(str(column) for column in frame.columns) or "（无列）"
        raise UpstreamSchemaError(
            f"{label}缺少列: {', '.join(missing)}；上游实际列: {actual}"
        )


def _normalize_daily_rows(
    rows: list[dict[str, Any]],
    code: str,
    fields: dict[str, str],
    label: str,
    volume_multiplier: int,
) -> list[dict[str, Any]]:
    by_date: dict[str, dict[str, Any]] = {}
    for row in rows:
        day = _date(row.get(fields["date"]))
        close = _positive(row.get(fields["close"]))
        if day is None or close is None:
            continue
        open_ = _positive(row.get(fields["open"]))
        high = _positive(row.get(fields["high"]))
        low = _positive(row.get(fields["low"]))
        if high is not None and low is not None and high < low:
            continue
        if high is not None and high < max(
            value for value in (open_, close, low) if value is not None
        ):
            continue
        if low is not None and low > min(
            value for value in (open_, close) if value is not None
        ):
            continue
        volume = _positive(row.get(fields["volume"]))
        amount = _number(row.get(fields["amount"]))
        if amount is not None and amount < 0:
            continue
        by_date[day] = {
            "trade_date": day,
            "open": round(open_, 4) if open_ is not None else None,
            "high": round(high, 4) if high is not None else None,
            "low": round(low, 4) if low is not None else None,
            "close": round(close, 4),
            "volume": int(round(volume * volume_multiplier)) if volume is not None else None,
            "amount": round(amount, 2) if amount is not None else None,
        }

    bars = [by_date[day] for day in sorted(by_date)]
    if not bars:
        raise UpstreamSchemaError(f"{code} 的{label}记录全部不合法（日期或价格缺失）")
    return bars


def normalize_daily_frame(frame: pd.DataFrame | None, code: str) -> list[dict[str, Any]]:
    rows = _records(frame)
    if not rows:
        return []
    assert frame is not None
    _require(frame, tuple(_EM_DAILY_FIELDS.values()), "日线")
    # 东财成交量单位是手。
    return _normalize_daily_rows(rows, code, _EM_DAILY_FIELDS, "日线", 100)


def normalize_sina_daily_frame(frame: pd.DataFrame | None, code: str) -> list[dict[str, Any]]:
    if (
        frame is not None
        and "date" not in frame.columns
        and getattr(frame.index, "name", None) == "date"
    ):
        frame = frame.reset_index()
    rows = _records(frame)
    if not rows:
        return []
    assert frame is not None
    _require(frame, tuple(_SINA_DAILY_FIELDS.values()), "新浪日线")
    # 新浪成交量已经是股，不再 ×100。
    return _normalize_daily_rows(rows, code, _SINA_DAILY_FIELDS, "新浪日线", 1)


def normalize_limit_pool_frame(frame: pd.DataFrame | None) -> list[dict[str, Any]]:
    rows = _records(frame)
    if not rows:
        return []
    assert frame is not None
    _require(frame, _LIMIT_REQUIRED, "涨停股池")

    by_code: dict[str, dict[str, Any]] = {}
    for row in rows:
        try:
            code = normalize_stock_code(_text(row.get("代码")))
        except InvalidCode:
            continue
        name = _text(row.get("名称"))
        if not name:
            continue
        by_code[code] = {
            "code": code,
            "name": name,
            "latest_price": _positive(row.get("最新价")),
            "pct_change": _number(row.get("涨跌幅")),
            "amount": _number(row.get("成交额")),
            "turnover_rate": _number(row.get("换手率")),
            "seal_amount": _number(row.get("封板资金")),
            "first_seal_time": _clock(row.get("首次封板时间")),
            "last_seal_time": _clock(row.get("最后封板时间")),
            "open_times": _integer(row.get("炸板次数")),
            "limit_up_stats": _text(row.get("涨停统计")) or None,
            "streak": _integer(row.get("连板数")),
            "industry": _text(row.get("所属行业")) or None,
        }

    items = [by_code[code] for code in sorted(by_code)]
    if not items:
        raise UpstreamSchemaError("涨停股池记录全部不合法（代码或名称缺失）")
    return items
