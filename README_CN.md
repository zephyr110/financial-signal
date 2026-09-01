<p align="right"><a href="./README.md">English</a></p>

# 财经信号 (Financial Signal)

AI 驱动的财经新闻聚合与政策-行业信号分析引擎。

仓库：[github.com/zephyr110/financial-signal](https://github.com/zephyr110/financial-signal)

**在线 Demo：** [https://financial-signal.vercel.app/](https://financial-signal.vercel.app/)

## 系统架构

```
新浪 / 同花顺 / 华尔街见闻 API
        │
        ▼
  新闻归档 (Turso/SQLite)
        │
        ▼
  LLM 分析管道 (DeepSeek / OpenAI 兼容)
  ├─ Step 1: 信号评分 (1-5)
  ├─ Step 2: 实体映射 (行业、公司、标签)
  └─ Step 3: 事件线索检测
        │
        ▼
  Next.js 16 (Pages Router) + ISR
        │
        ▼
  分析面板 (/analysis)
  ├─ 信号卡片 + 图表 + 时间线
  └─ 行情回测引擎
```

## 功能

- **多源新闻聚合** — 新浪、同花顺、华尔街见闻 7×24 实时快讯
- **AI 信号评分** — LLM 对每条新闻打分（1-5），分为政策、地缘、行业、公司、宏观六类
- **分析面板** — 渐变信号卡片、行业柱状图、分类环形图、趋势折线图、事件线索识别
- **个性化筛选** — 关注特定行业、按分数/分类筛选
- **行情回测** — 历史信号与行业指数收益关联分析
- **浏览器推送** — ≥4 分关键信号通知
- **RSS / JSON Feed** — 标准格式订阅
- **暗色模式** — 系统 + 手动切换

## 数据来源

| 来源 | 状态 | 说明 |
|------|------|------|
| 新浪财经 | ✅ 活跃 | 7×24 全球财经快讯 |
| 同花顺 | ✅ 活跃 | A 股标签新闻，20 条/批 |
| 华尔街见闻 | ✅ 活跃 | 全球宏观实时快讯 |
| 东方财富 | ⬜ 降级 | API 失效 (404) |
| 财联社 | ⬜ 降级 | 需鉴权签名 |

## 定时调度（三路互补）

1. **GitHub Actions**（`.github/workflows/cron.yml`）：每日 21:17 UTC（北京时间次日 05:17）兜底执行全管线，
   防止外部调度遗漏：
   ```
   fetch → analyze → deep-analyze → event-threads → fetch-market
   ```
   支持手动触发 (`workflow_dispatch`)。
2. **Vercel Cron**（`vercel.json`）：每日执行 `fetch` 与 `analyze`（Vercel Cron 上限两个端点）。
3. **QStash（生产可选）**：高频调度（如每 30 分钟）时 5 个端点各自独立触发，
   增量语义 + 唯一约束保证幂等可安全重跑；`deep-analyze`/`event-threads`/`fetch-market`
   内部自带 6h 节流，不会被高频调度推爆。

需配置 GitHub Secrets：`APP_URL`、`CRON_SECRET`。

## 快速开始

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build
pnpm start
pnpm test       # 39 个测试用例
pnpm typecheck  # tsc --noEmit
```

## 部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/zephyr110/financial-signal)

1. [Turso](https://turso.tech) 创建数据库
2. Vercel 配置环境变量：`LLM_API_KEY`、`CRON_SECRET`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`
3. GitHub Secrets 配置：`APP_URL`、`CRON_SECRET`
4. 手动触发一次 fetch + analyze 初始化数据

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | LLM API 密钥 | — |
| `LLM_BASE_URL` | Chat Completions 端点 | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 模型名称 | `deepseek-v4-flash` |
| `CRON_SECRET` | 保护 cron 端点 | — |
| `TURSO_DATABASE_URL` | Turso 数据库地址 | — |
| `TURSO_AUTH_TOKEN` | Turso 鉴权 token | — |
| `NEWS_DB_PATH` | 本地 SQLite 路径（开发模式） | `news_archive.db` |

## License

[MIT](LICENSE)
