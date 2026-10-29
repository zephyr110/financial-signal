import pandas as pd
import pytest

import akshare_sidecar.service as service
from akshare_sidecar.errors import UpstreamError

SINA_FRAME = pd.DataFrame([{
    "date": "2026-10-28", "open": 194.0, "high": 194.27, "low": 188.11,
    "close": 192.7, "volume": 16_310_008.0, "amount": 3_126_642_742.0,
}])


class FakeAk:
    def __init__(self, eastmoney=None, sina=None):
        self.eastmoney = eastmoney
        self.sina = sina
        self.eastmoney_calls = 0
        self.sina_calls = 0

    def stock_zh_a_hist(self, **_kwargs):
        self.eastmoney_calls += 1
        if isinstance(self.eastmoney, Exception):
            raise self.eastmoney
        return self.eastmoney

    def stock_zh_a_daily(self, **_kwargs):
        self.sina_calls += 1
        if isinstance(self.sina, Exception):
            raise self.sina
        return self.sina


@pytest.fixture(autouse=True)
def fast_and_unblocked(monkeypatch):
    monkeypatch.setenv("AKSHARE_MIN_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("AKSHARE_RETRY_DELAY_SECONDS", "0")
    monkeypatch.setattr(service, "_EASTMONEY_BLOCKED_UNTIL", 0.0)


def test_eastmoney_success_does_not_call_sina(monkeypatch):
    frame = pd.DataFrame([{
        "日期": "2026-10-28", "开盘": 194.0, "最高": 194.27, "最低": 188.11,
        "收盘": 192.7, "成交量": 163_100, "成交额": 3_126_642_742.0,
    }])
    fake = FakeAk(eastmoney=frame)
    monkeypatch.setattr(service, "_akshare", lambda: fake)

    bars, warnings, provider = service.fetch_daily("688041.SH", "2026-09-15", "2026-10-28")

    assert provider == "eastmoney"
    assert bars[0]["volume"] == 16_310_000
    assert warnings == []
    assert fake.sina_calls == 0


def test_eastmoney_failure_falls_back_to_sina(monkeypatch):
    fake = FakeAk(eastmoney=ConnectionError("Remote end closed connection"), sina=SINA_FRAME)
    monkeypatch.setattr(service, "_akshare", lambda: fake)

    bars, warnings, provider = service.fetch_daily("688041.SH", "2026-09-15", "2026-10-28")

    assert provider == "sina"
    assert bars[0]["volume"] == 16_310_008
    assert any("回退到新浪" in warning for warning in warnings)
    # _call 内部重试一次。
    assert fake.eastmoney_calls == 2
    assert fake.sina_calls == 1


def test_eastmoney_cooldown_skips_failed_source_on_next_code(monkeypatch):
    fake = FakeAk(eastmoney=ConnectionError("blocked"), sina=SINA_FRAME)
    monkeypatch.setattr(service, "_akshare", lambda: fake)
    monkeypatch.setenv("AKSHARE_SOURCE_COOLDOWN_SECONDS", "600")

    service.fetch_daily("688041.SH", "2026-09-15", "2026-10-28")
    eastmoney_after_first = fake.eastmoney_calls
    _, warnings, provider = service.fetch_daily("600519.SH", "2026-09-15", "2026-10-28")

    assert provider == "sina"
    assert fake.eastmoney_calls == eastmoney_after_first
    assert any("冷却" in warning for warning in warnings)


def test_both_daily_sources_failing_raises(monkeypatch):
    fake = FakeAk(
        eastmoney=ConnectionError("eastmoney down"),
        sina=ConnectionError("sina down"),
    )
    monkeypatch.setattr(service, "_akshare", lambda: fake)

    with pytest.raises(UpstreamError, match="均失败"):
        service.fetch_daily("688041.SH", "2026-09-15", "2026-10-28")
