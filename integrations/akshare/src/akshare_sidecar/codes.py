"""股票代码规范化：对外统一为 6 位代码 + .SH/.SZ/.BJ。"""

from __future__ import annotations

import re


class InvalidCode(ValueError):
    pass


_SUFFIXED = re.compile(r"^(\d{6})\.(SH|SZ|BJ)$")


# 只认沪深京 A 股代码前缀；基金、B 股、指数不进入 T2 补充范围。
_EXCHANGE_PREFIXES = (
    ("SH", ("600", "601", "603", "605", "688", "689")),
    ("SZ", ("000", "001", "002", "003", "300", "301")),
    ("BJ", ("43", "82", "83", "84", "87", "88", "920")),
)


def exchange_of(symbol: str) -> str | None:
    for suffix, prefixes in _EXCHANGE_PREFIXES:
        if symbol.startswith(prefixes):
            return suffix
    return None


def normalize_stock_code(value: str) -> str:
    text = (value or "").strip().upper()
    match = _SUFFIXED.match(text)
    if match:
        symbol, suffix = match.groups()
        inferred = exchange_of(symbol)
        if inferred is None or inferred != suffix:
            raise InvalidCode(f"代码与交易所后缀不匹配: {value}")
        return f"{symbol}.{suffix}"

    for prefix in ("SH", "SZ", "BJ"):
        if text.startswith(prefix) and re.fullmatch(r"\d{6}", text[2:]):
            symbol = text[2:]
            if exchange_of(symbol) != prefix:
                raise InvalidCode(f"代码与交易所前缀不匹配: {value}")
            return f"{symbol}.{prefix}"

    if re.fullmatch(r"\d{6}", text):
        suffix = exchange_of(text)
        if suffix is None:
            raise InvalidCode(f"无法识别的股票代码: {value}")
        return f"{text}.{suffix}"

    raise InvalidCode(f"股票代码应为 600519、600519.SH 或 SH600519: {value}")


def symbol_of(code: str) -> str:
    return code.split(".", 1)[0]
