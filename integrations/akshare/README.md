# AKShare 侧车（T2 补充）

个人投研驾驶舱的独立 Python 采集侧车，只提供两项数据：

- `GET /v1/daily`：单只 A 股的不复权日线
- `GET /v1/limit-pool`：某一交易日的涨停股池

它**不在 Next.js 请求路径里**，也不替代 T0 官方公告或 T1 Tushare。任务中心里的
「T2 补充入库」才会调用它，写入的日线使用插入忽略语义：已有 T0/T1 行不会被覆盖。

## 安装与启动

要求 Python ≥ 3.11（AKShare 1.20.2）。

```bash
cd integrations/akshare
python3.11 -m venv .venv
.venv/bin/pip install -e '.[dev]'

export AKSHARE_SIDECAR_TOKEN='换成一串随机值'
.venv/bin/akshare-sidecar
# 等价于：.venv/bin/python -m akshare_sidecar
```

默认监听 `127.0.0.1:8765`。需要改端口用 `AKSHARE_SIDECAR_PORT`；
非回环地址默认拒绝启动，确需内网访问要同时设置 `AKSHARE_ALLOW_NETWORK=1`。

在项目根目录的 `.env.local` 里配置同一组值：

```bash
AKSHARE_SIDECAR_URL=http://127.0.0.1:8765
AKSHARE_SIDECAR_TOKEN=与侧车环境变量一致
```

两项缺任意一项时，`akshare_ingest` 任务会明确跳过，不会发请求、不会写库。

## HTTP 口径

除 `/health` 外都需要 `Authorization: Bearer <token>`。未配置 token 时数据端点返回 503，
token 不匹配返回 401。`/docs`、`/openapi.json` 已关闭。

```json
// GET /v1/daily?code=688041.SH&start=2026-09-01&end=2026-10-28
{
  "code": "688041.SH",
  "adjust": "none",
  "provider": "eastmoney",
  "bars": [
    {
      "trade_date": "2026-10-28",
      "open": 100.0, "high": 105.0, "low": 99.0, "close": 104.0,
      "volume": 1234500,
      "amount": 128000000.0
    }
  ],
  "warnings": [],
  "latest_trade_date": "2026-10-28",
  "source": { "id": "akshare", "tier": 2, "upstream": "eastmoney", "fetched_at": "..." }
}
```

- 日线先走东方财富（`stock_zh_a_hist`），连接失败时自动回退到新浪
  （`stock_zh_a_daily`），并把失败过的源冷却 10 分钟；`provider` 标明本次实际来源。
- 成交量单位是**股**（东财给的是手，侧车 ×100；新浪本来就是股）。
- 成交额单位是**元**。
- 只提供不复权日线；`adjust` 只接受 `none`。
- 空数据返回 200 + `bars: []` + 非空 `warnings`，不能当成 0。
- 日线必需列变化、记录全部不合法返回 502 `UPSTREAM_SCHEMA`，不静默吞掉。
- 单次窗口上限 366 天。

`GET /v1/limit-pool?trade_date=2026-10-28` 返回 `items`，字段包含代码、名称、最新价、
涨跌幅、成交额、换手率、封板资金、首次/最后封板时间、炸板次数、涨停统计、连板数、行业。
涨停股池为空时同样返回 200 + 警告（无法区分非交易日、尚未更新与确实无涨停）。

本地排查可以直接走 CLI，不经过 HTTP：

```bash
.venv/bin/python -m akshare_sidecar.cli daily --code 688041.SH --start 2026-10-01 --end 2026-10-28
.venv/bin/python -m akshare_sidecar.cli limit-pool --trade-date 2026-10-28
```

## 安全与部署约束

- 侧车只绑定回环地址，供本机 Next.js 调用；**不要**挂公网、不要加反向代理前缀。
- token 用足够长的随机串，只放在服务端环境变量里；侧车日志不打印 token。
- 无 CORS、无写接口、无文档页；只有只读 GET。
- 所有 AKShare 调用串行执行（一把进程内锁），默认间隔 1.2 秒；连接被上游断开时
  最多重试一次。可用 `AKSHARE_MIN_INTERVAL_SECONDS`、`AKSHARE_RETRY_DELAY_SECONDS` 调整。
  东财失败后的冷却时间用 `AKSHARE_SOURCE_COOLDOWN_SECONDS`（默认 600 秒）。
- 侧车必须与主应用同机（或个人可信内网）。AKShare 是抓取聚合，上游可能限流、
  封 IP 或静默改列。实测东财 K 线接口在短时间多次请求后会直接断开连接，
  因此侧车有源冷却与新浪回退；仍失败时任务只保留可用的部分并给出警告，
  缺失值应回退 T0/T1，而不是画成 0。
- 侧车失败只会让 `akshare_ingest` 任务失败并更新 T2 来源健康度，不影响 T0/T1。

## 数据与许可

AKShare 代码是 MIT，但它抓取的上游数据（东方财富等）授权不归 AKShare 覆盖，
README 也注明仅供学术研究参考。本项目只作个人研究用途、低频、单机、非分发；
如需商用或对外提供服务，应改用有授权与 SLA 的数据源。

## 测试

```bash
.venv/bin/pytest -q
```

测试只用合成 DataFrame，不联网、不落真实行情。
