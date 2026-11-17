# 财经信号 · Financial Signal

[English](README.md) · [中文](README_CN.md)

面向个人投资者的 A 股投研驾驶舱：把官方披露、日线行情与隔夜外盘整理成每日市场判断、行业逐条结论、风险预警和可追溯证据的深挖结论。只做研究，不接券商、不执行交易、不构成投资建议。

仓库：[github.com/zephyr110/financial-signal](https://github.com/zephyr110/financial-signal)

## 功能

- **今日（`/today`）** — 收盘简报：市场为什么动、哪些行业转强或转弱，以及驱动它们的新闻线索。
- **投研台（`/desk`）** — 驾驶舱：市场脉搏（评分 / 立场 / 置信度）、按强度排序的行业判断、可一键深挖的未处理预警，以及隔夜外盘行情。全屏多面板，一屏完成盘前决策。
- **自选与持仓（`/watchlist`、`/portfolio`）** — 股票代码、行业暴露和自己的备注；行业判断优先排列你实际持有的方向。
- **研究笔记（`/research`）** — 论点、证据，以及带事后结果的投资日记。
- **研究助手（`/agent`）** — 基于本地档案问答；助手可保存长期记忆、把证据固定到研究项目、登记关注事件并入队调查。会话可生成只读分享链接。会话、记忆、项目与动作提案按登录账号隔离；升级前的历史数据仍作为 legacy 共享数据可见。
- **信号分析（`/analysis`）** — 原有新闻管线：LLM 打分、实体映射、事件线索与行业回测。
- **任务中心（`/tasks`）** — 单 worker、`core` / `interactive` 双 lane；每个任务展示进度、尝试次数、成本与实时事件。

可安装为移动端 PWA，也提供 Electron 桌面端，完全离线可用。

## 研究链路

```
T0 官方披露 ─┐
Tushare 行情 ─┼─► 行业聚合 ─► 市场 + 行业判断
新闻源 ───────┘                  │
                                 ├─► 风险预警 ─► 深挖调查（研究助手）
CBOE 延迟行情 ─► 隔夜外盘背景     └─► 事后验证（1/5/20 个交易日）
        │
        ▼
   SQLite / libSQL  ─►  Next.js 16 (Pages Router)  ─►  驾驶舱界面（PWA）
```

- **每日收盘（`daily_close`）** 拉取行情、抓取官方公告，生成并校验收盘简报。
- **投研台刷新（`desk_tick`）** 聚合行业宽度、成交额与动量，在一个事务里写入判断与证据，再对到期判断做事后验证。
- **深挖调查（`desk_investigation`）** 跑在交互 lane，慢证据收集不会阻塞收盘链路。

## 数据来源

| 来源 | 层级 | 用途 |
|------|------|------|
| 上海证券交易所 | T0 | 公告，仅保存标题与官方原文链接 |
| 巨潮资讯 | T0 | 深市公告 |
| 中国证监会 | T0 | 政策解读 |
| Tushare Pro | T1 | 日线行情、交易日历（`TUSHARE_TOKEN`） |
| AKShare | T2 | 通过公开接口补充行情 |
| CBOE 延迟行情 | T1 | 隔夜标普 500 / 纳斯达克 100 / 道琼斯，延迟 15 分钟 |
| 可选付费快照源 | T1 | 行情/快讯逐条带 `delaySeconds`（`REALTIME_SOURCE_URL`）；默认关闭，缺延迟标注的条目直接丢弃 |
| 新浪 / 同花顺 / 华尔街见闻 | 新闻 | 7×24 快讯，供信号管线使用 |

- 每条判断都带证据、来源名称与时间。
- **示例数据隔离**：含示例数据的库会拒绝接入真实行情（`assertNoDemoData`），示例数字与真实数字绝不混用。
- **可降级**：未配置 LLM 时简报退回确定性事实叙述，收盘链路照常完成。

## 快速开始

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build
pnpm start
pnpm test       # Vitest，832 项
pnpm typecheck  # tsc --noEmit
```

把 `.env.example` 复制为 `.env.local` 并按需填写。应用在单用户登录门卫（`proxy.ts`）之后，首次运行会创建初始账号。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | LLM 密钥（简报叙述、研究助手、信号打分） | — |
| `LLM_BASE_URL` | Chat Completions 端点 | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 模型名称 | `deepseek-v4-flash` |
| `TUSHARE_TOKEN` | Tushare Pro 行情/日历凭证（也可在应用内设置） | — |
| `CRON_SECRET` | 保护 `/api/cron/*` 机器端点 | — |
| `COCKPIT_DEMO` | `1` 时播种示例数据，仅本地演示 | — |
| `DB_BACKEND` | `local` 或 `turso`；覆盖并锁定设置页的选择 | `local`（Vercel 默认 `turso`） |
| `TURSO_DATABASE_URL` | 部署用 Turso 地址；仅 Vercel 或 `DB_BACKEND=turso` 时生效 | — |
| `TURSO_AUTH_TOKEN` | 部署用 Turso token；仅 Vercel 或 `DB_BACKEND=turso` 时生效 | — |
| `DB_CONFIG_PATH` | 覆盖设置页存储选择的保存位置（仅自托管/服务端；桌面端固定使用数据目录） | 与 `NEWS_DB_PATH` 同目录的 `db-config.json` |
| `NEWS_DB_PATH` | 本地 SQLite 路径 | `news_archive.db` |
| `AUTH_DB_PATH` | 独立认证库（桌面端） | 与 `NEWS_DB_PATH` 同目录 |

解析顺序：显式 `DB_BACKEND` → Vercel（强制 Turso）→ 设置页选择 → 本地文件。只残留一个 `TURSO_DATABASE_URL` 不会生效，避免旧凭据把已有安装悄悄重定向。设置页的凭据只写入数据库旁的 `db-config.json`（权限 0600、已 gitignore）；切换后端或修改 Turso 凭据后需重启应用。

## 桌面端（Electron）

离线自给自足：内置抓取与分析管线、默认本地 SQLite（可在设置中切换 Turso）、托盘通知与自动更新。

- **开发**：`pnpm dev:desktop`（Next dev + Electron 窗口）
- **本地打包（mac）**：`NEWS_DB_PATH=./seed/news_archive.db pnpm dist:dir`
- **发布**：推 `v*` tag，CI 三平台打包上传 GitHub Releases。mac 包当前未签名，首次打开会被 Gatekeeper 拦截：右键 → 打开，或 `xattr -cr "/Applications/Financial Signal.app"`。未签名的 mac 包无法自动更新，需手动下载新版本。
- **数据目录**：macOS `~/Library/Application Support/financial-signal/`、Windows `%APPDATA%/financial-signal`、Linux `~/.config/financial-signal`。内含 `news_archive.db`；切换存储后还会写入 `db-config.json`。
- **首次启动**：可导入现有 `news_archive.db` 或全新开始；在设置里配置 LLM key 后分析管线自动启用。
- **调度**：内置调度器默认每 30 分钟运行一次，可在 设置 → 自动刷新 中启停或调整间隔；本地库与 Turso 均可使用。

## 部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/zephyr110/financial-signal)

自托管默认使用本地 SQLite；需要云端时在 设置 → 数据与存储 切换到 Turso（凭据留在宿主机 `db-config.json`），或设置 `DB_BACKEND=turso` 并提供 `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`。Vercel 因文件系统非持久，必须使用 Turso，未显式指定时自动选择。

1. 在 [Turso](https://turso.tech) 创建数据库。
2. Vercel 配置 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`、`LLM_API_KEY`、`CRON_SECRET`（无需 `DB_BACKEND`）。
3. GitHub Secrets 配置 `APP_URL` 与 `CRON_SECRET` 供兜底工作流使用。
4. 手动触发一次 `fetch` 与 `analyze` 初始化数据。

自托管若通过设置页使用 Turso，请把 `db-config.json` 放在与数据库相同的可写持久卷上；切换后端或凭据后需重启进程。

桌面端由内置调度器驱动（默认 30 分钟，可在设置中调整）。Web 部署没有常驻调度：由 GitHub Actions（每天北京时间 05:17 跑全管线）、Vercel Cron（`fetch` + `analyze`）和可选 QStash 承担。所有端点幂等、自带节流，并受 `CRON_SECRET` 保护。

## 文档

- [驾驶舱运行手册](docs/cockpit-runbook.md) — 数据源、任务、运维与排障。

## 免责声明

本项目是个人研究工具，不提供投资建议，不连接任何券商，不执行交易。市场有风险，决策请自行负责。

## License

[MIT](LICENSE)
