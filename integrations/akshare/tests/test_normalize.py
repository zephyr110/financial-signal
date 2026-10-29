import pandas as pd
import pytest

from akshare_sidecar.errors import UpstreamSchemaError
from akshare_sidecar.normalize import (
    normalize_daily_frame,
    normalize_limit_pool_frame,
    normalize_sina_daily_frame,
)

DAILY_COLUMNS = ["日期", "开盘", "最高", "最低", "收盘", "成交量", "成交额"]


def daily(rows):
    return pd.DataFrame(rows, columns=DAILY_COLUMNS)


def limit(rows):
    columns = [
        "代码", "名称", "最新价", "涨跌幅", "成交额", "换手率", "封板资金",
        "首次封板时间", "最后封板时间", "炸板次数", "涨停统计", "连板数", "所属行业",
    ]
    return pd.DataFrame(rows, columns=columns)


def test_daily_normalizes_units_dates_and_sorts():
    frame = daily([
        ["20261028", 100, 105, 99, 104, 12345, 128_000_000.0],
        ["2026-10-27", 98, 101, 97, 100, 1000, 101_000_000.0],
    ])

    bars = normalize_daily_frame(frame, "688041.SH")

    assert [bar["trade_date"] for bar in bars] == ["2026-10-27", "2026-10-28"]
    assert bars[1]["volume"] == 1_234_500
    assert bars[1]["amount"] == 128_000_000.0
    assert bars[1]["close"] == 104.0


def test_daily_dedupes_same_date_keeping_last_row():
    frame = daily([
        ["2026-10-28", 100, 105, 99, 104, 12345, 128_000_000.0],
        ["2026-10-28", 100, 106, 99, 105, 22222, 129_000_000.0],
    ])

    bars = normalize_daily_frame(frame, "688041.SH")

    assert len(bars) == 1
    assert bars[0]["close"] == 105.0
    assert bars[0]["volume"] == 2_222_200


def test_daily_empty_frame_is_empty_not_schema_error():
    assert normalize_daily_frame(daily([]), "688041.SH") == []


def test_daily_missing_column_raises_schema_error():
    frame = pd.DataFrame([["2026-10-28", 100, 104]], columns=["日期", "开盘", "收盘"])

    with pytest.raises(UpstreamSchemaError, match="缺少列"):
        normalize_daily_frame(frame, "688041.SH")


def test_daily_all_invalid_rows_raise_instead_of_silent_empty():
    frame = daily([["不是日期", 0, 0, 0, 0, 0, 0]])

    with pytest.raises(UpstreamSchemaError, match="全部不合法"):
        normalize_daily_frame(frame, "688041.SH")


def test_sina_daily_keeps_share_volume_without_multiplying():
    frame = pd.DataFrame([{
        "date": "2026-10-28", "open": 194.0, "high": 194.27, "low": 188.11,
        "close": 192.7, "volume": 16_310_008.0, "amount": 3_126_642_742.0,
    }])

    bars = normalize_sina_daily_frame(frame, "688041.SH")

    assert len(bars) == 1
    assert bars[0]["volume"] == 16_310_008
    assert bars[0]["amount"] == 3_126_642_742.0
    assert bars[0]["close"] == 192.7


def test_limit_pool_normalizes_codes_times_and_nan():
    frame = limit([
        ["688041", "海光信息", 150.2, 20.01, 5_000_000_000.0, 3.2, 800_000_000.0,
         "093000", "145900", 2, "3/2", 3, "半导体"],
        ["999999", "无效代码", 1, 10, 1, 1, 1, "093000", "145900", 0, "1/1", 1, "其他"],
    ])

    items = normalize_limit_pool_frame(frame)

    assert len(items) == 1
    assert items[0]["code"] == "688041.SH"
    assert items[0]["first_seal_time"] == "09:30:00"
    assert items[0]["open_times"] == 2
    assert items[0]["streak"] == 3
    assert items[0]["industry"] == "半导体"


def test_limit_pool_all_invalid_raises_schema_error():
    frame = limit([["999999", "", 1, 10, 1, 1, 1, "093000", "145900", 0, "1/1", 1, "其他"]])

    with pytest.raises(UpstreamSchemaError, match="全部不合法"):
        normalize_limit_pool_frame(frame)
