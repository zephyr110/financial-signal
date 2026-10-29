import pytest
from fastapi.testclient import TestClient

import akshare_sidecar.app as app_module
import akshare_sidecar.service as service
from akshare_sidecar.errors import UpstreamError, UpstreamSchemaError

client = TestClient(app_module.app)
AUTH = {"Authorization": "Bearer test-token"}


@pytest.fixture(autouse=True)
def token_env(monkeypatch):
    monkeypatch.setenv("AKSHARE_SIDECAR_TOKEN", "test-token")


def test_health_is_public_and_does_not_need_token():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.headers["cache-control"] == "no-store"


def test_daily_requires_bearer_token():
    assert client.get("/v1/daily?code=688041.SH&start=2026-10-01&end=2026-10-28").status_code == 401
    assert client.get(
        "/v1/daily?code=688041.SH&start=2026-10-01&end=2026-10-28",
        headers={"Authorization": "Bearer wrong"},
    ).status_code == 401


def test_missing_server_token_returns_503(monkeypatch):
    monkeypatch.delenv("AKSHARE_SIDECAR_TOKEN")
    response = client.get(
        "/v1/daily?code=688041.SH&start=2026-10-01&end=2026-10-28",
        headers=AUTH,
    )
    assert response.status_code == 503


def test_daily_returns_normalized_payload(monkeypatch):
    bars = [{
        "trade_date": "2026-10-28", "open": 100.0, "high": 105.0, "low": 99.0,
        "close": 104.0, "volume": 1_234_500, "amount": 128_000_000.0,
    }]

    def fake_fetch(code, start, end):
        assert (code, start, end) == ("688041.SH", "2026-10-01", "2026-10-28")
        return bars, [], "eastmoney"

    monkeypatch.setattr(app_module, "fetch_daily", fake_fetch)
    response = client.get(
        "/v1/daily?code=688041&start=2026-10-01&end=2026-10-28", headers=AUTH
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["code"] == "688041.SH"
    assert payload["latest_trade_date"] == "2026-10-28"
    assert payload["bars"] == bars
    assert payload["warnings"] == []
    assert payload["provider"] == "eastmoney"
    assert payload["source"]["tier"] == 2


def test_daily_rejects_adjusted_and_inverted_windows(monkeypatch):
    monkeypatch.setattr(app_module, "fetch_daily", lambda *args: ([], [], "eastmoney"))
    assert client.get(
        "/v1/daily?code=688041.SH&start=2026-10-01&end=2026-10-28&adjust=qfq", headers=AUTH
    ).status_code == 400
    assert client.get(
        "/v1/daily?code=688041.SH&start=2026-10-28&end=2026-10-01", headers=AUTH
    ).status_code == 400
    assert client.get(
        "/v1/daily?code=ABCDEF&start=2026-10-01&end=2026-10-28", headers=AUTH
    ).status_code == 400


def test_empty_daily_keeps_warning_instead_of_fake_zero(monkeypatch):
    monkeypatch.setattr(
        app_module, "fetch_daily",
        lambda code, start, end: ([], ["无日线数据"], "sina"),
    )
    response = client.get(
        "/v1/daily?code=688041.SH&start=2026-10-01&end=2026-10-28", headers=AUTH
    )
    assert response.status_code == 200
    assert response.json()["bars"] == []
    assert response.json()["warnings"] == ["无日线数据"]
    assert response.json()["latest_trade_date"] is None


def test_schema_drift_returns_502(monkeypatch):
    def broken(*_args):
        raise UpstreamSchemaError("上游缺少列: 收盘")

    monkeypatch.setattr(app_module, "fetch_daily", broken)
    response = client.get(
        "/v1/daily?code=688041.SH&start=2026-10-01&end=2026-10-28", headers=AUTH
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "UPSTREAM_SCHEMA"


def test_limit_pool_returns_items(monkeypatch):
    items = [{"code": "688041.SH", "name": "海光信息", "streak": 3}]
    monkeypatch.setattr(app_module, "fetch_limit_pool", lambda trade_date: (items, []))
    response = client.get("/v1/limit-pool?trade_date=2026-10-28", headers=AUTH)
    assert response.status_code == 200
    assert response.json()["items"] == items
    assert response.json()["trade_date"] == "2026-10-28"


def test_call_retries_once_then_succeeds(monkeypatch):
    monkeypatch.setenv("AKSHARE_MIN_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("AKSHARE_RETRY_DELAY_SECONDS", "0")
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) == 1:
            raise ConnectionError("Remote end closed connection")
        return "ok"

    assert service._call("测试", flaky) == "ok"
    assert len(attempts) == 2


def test_call_surfaces_upstream_error_after_retry(monkeypatch):
    monkeypatch.setenv("AKSHARE_MIN_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("AKSHARE_RETRY_DELAY_SECONDS", "0")

    def broken():
        raise ConnectionError("boom")

    with pytest.raises(UpstreamError, match="ConnectionError"):
        service._call("测试", broken)
