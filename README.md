# Financial Signal · 财经信号

[English](README.md) · [中文](README_CN.md)

A personal research cockpit for the A-share market. It turns official disclosures, daily quotes and overnight overseas moves into a daily market judgment, industry-by-industry calls, risk alerts and evidence-backed deep dives. Research only — no broker connection, no order execution, no investment advice.

Repository: [github.com/zephyr110/financial-signal](https://github.com/zephyr110/financial-signal)

## What it does

- **Today (`/today`)** — the closing brief: what moved the market, which industries strengthened or weakened, and the news feed that drove it.
- **Desk (`/desk`)** — the cockpit: market pulse with score / stance / confidence, ranked industry judgments, open risk alerts with one-click deep dive, and overnight overseas quotes. Full-screen, multi-panel, and designed to stay on one screen.
- **Watchlist & portfolio (`/watchlist`, `/portfolio`)** — codes, industry exposure and your own notes; industry judgments are ordered by what you actually hold.
- **Research notes (`/research`)** — theses, evidence and a journal of decisions with their outcomes.
- **Research agent (`/agent`)** — ask questions over the local archive; the agent can save memories, pin evidence to projects, document watch items and queue investigations. Sessions can be shared as read-only links.
- **Signal analysis (`/analysis`)** — the original news pipeline: LLM scoring, entity mapping, event threads and industry backtests.
- **Task center (`/tasks`)** — a single worker with `core` / `interactive` lanes; each task shows progress, attempts, cost and live events.

Installable as a PWA on mobile, and shipped as an Electron desktop app for fully offline use.

## Research pipeline

```
T0 official disclosures ─┐
Tushare Pro market data ─┼─► industry aggregation ─► market + industry judgments
news sources ────────────┘                              │
                                                        ├─► alerts ─► investigations (agent)
CBOE delayed quotes ─────► overnight context            └─► evaluations (1/5/20 trading days)
        │
        ▼
   SQLite / libSQL  ─►  Next.js 16 (Pages Router)  ─►  cockpit UI (PWA)
```

- **Daily close (`daily_close`)** pulls quotes, ingests official announcements and produces the verified closing brief.
- **Desk tick (`desk_tick`)** aggregates industry breadth, turnover and momentum, writes judgments and evidence in one transaction, then evaluates matured judgments against realized returns.
- **Investigations (`desk_investigation`)** run on the interactive lane so slow evidence collection never blocks the closing pipeline.

## Data sources

| Source | Tier | Use |
|--------|------|-----|
| Shanghai Stock Exchange (SSE) | T0 | Announcements, original links only |
| CNINFO (巨潮资讯) | T0 | Shenzhen-listed announcements |
| CSRC (中国证监会) | T0 | Policy interpretations |
| Tushare Pro | T1 | Daily bars, trading calendar (`TUSHARE_TOKEN`) |
| AKShare | T2 | Supplementary market data via public endpoints |
| CBOE delayed quotes | T1 | Overnight S&P 500 / NASDAQ 100 / Dow, 15-minute delay |
| Sina / 10jqka / Wallstreetcn | news | 7×24 flash news for the signal pipeline |

- Every displayed judgment carries its evidence, source name and timestamp.
- **Demo isolation**: a demo database refuses to ingest real market data (`assertNoDemoData`), so sample and real numbers are never mixed.
- **Graceful degradation**: without an LLM key the brief falls back to deterministic facts and the closing pipeline still completes.

## Quick start

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build
pnpm start
pnpm test       # Vitest, 583 tests
pnpm typecheck  # tsc --noEmit
```

Copy `.env.example` to `.env.local` and fill in what you need. The app is behind a single-user login gate (`proxy.ts`); the first account is seeded on first run.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_API_KEY` | LLM API key (brief narration, agent, signal scoring) | — |
| `LLM_BASE_URL` | Chat completions endpoint | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | Model name | `deepseek-v4-flash` |
| `TUSHARE_TOKEN` | Tushare Pro token for quotes and calendar (also settable in-app) | — |
| `CRON_SECRET` | Protects `/api/cron/*` machine endpoints | — |
| `COCKPIT_DEMO` | `1` seeds sample data for local demos only | — |
| `TURSO_DATABASE_URL` | Turso database URL (production) | — |
| `TURSO_AUTH_TOKEN` | Turso auth token | — |
| `NEWS_DB_PATH` | Local SQLite path | `news_archive.db` |
| `AUTH_DB_PATH` | Separate auth database (desktop) | beside `NEWS_DB_PATH` |

## Desktop app (Electron)

Fully self-contained: built-in fetch and analysis pipelines, local SQLite, tray notifications and auto-update.

- **Develop**: `pnpm dev:desktop` (Next dev server + Electron window)
- **Package locally (mac)**: `NEWS_DB_PATH=./seed/news_archive.db pnpm dist:dir`
- **Release**: push a `v*` tag; CI builds all three platforms and uploads to GitHub Releases. macOS builds are currently unsigned, so Gatekeeper blocks the first launch: right-click → Open, or `xattr -cr "/Applications/Financial Signal.app"`. Unsigned macOS builds cannot auto-update; download the new version manually.
- **Data directory**: macOS `~/Library/Application Support/financial-signal/`, Windows `%APPDATA%/financial-signal`, Linux `~/.config/financial-signal`
- **First run**: import an existing `news_archive.db` or start fresh, then set the LLM key in Settings.

## Deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/zephyr110/financial-signal)

1. Create a database on [Turso](https://turso.tech).
2. Set `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `LLM_API_KEY` and `CRON_SECRET` in Vercel.
3. Configure GitHub Secrets `APP_URL` and `CRON_SECRET` for the fallback workflow.
4. Trigger `fetch` and `analyze` once to seed initial data.

Three complementary schedules keep data fresh: GitHub Actions (daily full pipeline at 05:17 Beijing time), Vercel Cron (`fetch` + `analyze`), and optional QStash for high-frequency runs. All endpoints are idempotent and self-throttle.

## Documentation

- [Cockpit runbook](docs/cockpit-runbook.md) — data sources, tasks, operations and troubleshooting.

## Disclaimer

This project is a personal research tool. It does not provide investment advice, does not connect to any broker and does not execute trades. Markets carry risk; decisions are your own.

## License

[MIT](LICENSE)
