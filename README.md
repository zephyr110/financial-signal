# Financial Signal

AI-powered financial news aggregation & policy-industry signal analysis engine.

Repository: [github.com/zephyr110/financial-signal](https://github.com/zephyr110/financial-signal)

**Live Demo:** [https://financial-news-nine.vercel.app](https://financial-news-nine.vercel.app)

## System Architecture

```
Sina / 10jqka / Wallstreetcn APIs
        │
        ▼
  News Archive (Turso/SQLite)
        │
        ▼
  LLM Analysis Pipeline (DeepSeek / OpenAI-compatible)
  ├─ Step 1: Signal Scoring (1-5)
  ├─ Step 2: Entity Mapping (industries, companies, tags)
  └─ Step 3: Event Thread Detection
        │
        ▼
  Next.js 16 (Pages Router) + ISR
        │
        ▼
  Analysis Dashboard (/analysis)
  ├─ Signal Cards + Charts + Timeline
  └─ Market Backtest Engine
```

## Features

- **Multi-source news aggregation** — Sina, 10jqka, Wallstreetcn 7×24 tickers
- **AI signal scoring** — LLM evaluates every news item (1–5), classifying by policy, geopolitics, industry, company, macro
- **Analysis dashboard** — gradient signal cards, industry bar chart, category donut chart, trend line chart, event thread detection
- **Personalized filtering** — watch specific industries, filter by score/category
- **Market backtest** — correlate historical signals with sector index returns
- **Browser notifications** — push alerts for critical signals (≥4)
- **RSS / JSON Feed** — subscribe via standard feed formats
- **Dark mode** — system-aware theme with manual toggle

## Data Sources

| Source | Status | Description |
|--------|--------|-------------|
| Sina Finance | ✅ Active | 7×24 global financial flash news |
| 10jqka (同花顺) | ✅ Active | A-stock tagged news, 20 items/batch |
| Wallstreetcn (华尔街见闻) | ✅ Active | Global macro live news |
| Eastmoney | ⬜ Degraded | API deprecated (404) |
| CLS (财联社) | ⬜ Degraded | Requires auth signature |

## GitHub Actions

Hourly scheduled pipeline (`13 */4 * * *`):

```
fetch → analyze → deep-analyze → event-threads → fetch-market
```

Manual trigger also available via `workflow_dispatch`.

GitHub Secrets required: `APP_URL`, `CRON_SECRET`.

## Quick Start

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build
pnpm start
pnpm test       # 39 tests
pnpm typecheck  # tsc --noEmit
```

## Desktop App (Electron)

离线自给自足的桌面端:内置抓取 + LLM 分析管线、本地 SQLite、托盘通知与自动更新,不依赖远程服务器。

- **开发**: `pnpm dev:desktop`(next dev + Electron 窗口)
- **打包(本地 mac)**: `NEWS_DB_PATH=./seed/news_archive.db pnpm dist:dir`
- **发布**: push `v*` tag,CI 三平台打包上传 GitHub Releases。mac 包当前未签名(CI 无签名证书),首次打开会被 Gatekeeper 拦截:右键应用 → 打开,或 `xattr -cr "/Applications/Financial Signal.app"`;正式分发需配置 Apple Developer 证书 + notarization。注意:mac 包未签名时 electron-updater 自动更新不会生效,升级需手动下载新版本安装
- **数据目录**: macOS `~/Library/Application Support/financial-signal/`、Windows `%APPDATA%/financial-signal`、Linux `~/.config/financial-signal`
- **首次启动**: 可导入现有 `news_archive.db` 或全新开始;在设置弹窗配置 LLM key 后分析管线自动启用

桌面端新增代码集中在 `electron/` 与 `scripts/`,Web 侧仅 `proxy.ts`/`cronAuth.ts` 增加 DESKTOP_MODE 放行、`next.config.js` 增加 standalone 输出。

## Deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/zephyr110/financial-signal)

1. Create a database on [Turso](https://turso.tech)
2. Set Vercel env vars: `LLM_API_KEY`, `CRON_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
3. Configure GitHub Secrets: `APP_URL`, `CRON_SECRET`
4. Manually trigger fetch + analyze once to seed initial data

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_API_KEY` | LLM API key | — |
| `LLM_BASE_URL` | Chat completions endpoint | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | Model name | `deepseek-v4-flash` |
| `CRON_SECRET` | Protects cron endpoints | — |
| `TURSO_DATABASE_URL` | Turso DB URL (production) | — |
| `TURSO_AUTH_TOKEN` | Turso auth token | — |
| `NEWS_DB_PATH` | Local SQLite path (dev) | `news_archive.db` |

## License

[MIT](LICENSE)
