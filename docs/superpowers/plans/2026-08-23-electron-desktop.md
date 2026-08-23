# Electron 桌面端实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 financial-signal 增加离线自给自足的 Electron 桌面端(自带抓取+LLM 管线、本地 SQLite、托盘通知、三平台打包与自动更新)。

**Architecture:** Next.js `output: 'standalone'` 自包含服务器由 Electron 主进程拉起(随机端口 + 健康检查 + 崩溃重启),BrowserWindow 加载 `http://127.0.0.1:<port>`。管线复用现有 `pages/api/cron/*`(DESKTOP_MODE 跳过鉴权),调度器、通知、导入逻辑抽成不依赖 electron 的纯函数模块以便 vitest 单测。

**Tech Stack:** Electron 43 / electron-builder 26 / electron-updater 6 / Next.js standalone / @libsql/client / vitest(已有)

**关键背景(执行者必读):**
- 全部 Web 页面/API/管线代码**零改动**(除 proxy.ts、cronAuth.ts 各加 DESKTOP_MODE 判定、next.config.js 加 output)
- 新增代码收敛在 `electron/`(CommonJS .js,不进 Next 构建链)与 `scripts/`
- `pnpm build` 会触发 prebuild 的 `scripts/verify-data.mjs`,要求 DB 含 7 张关键表 → 本地/CI 构建需用 Task 1 的 seed 脚本
- 测试框架 vitest(jsdom,globals:true),新测试放 `tests/electron/`
- 当前分支:`worktree-feat+electron-desktop`(worktree 内完成全部工作)

---

### Task 1: Next.js standalone 输出 + 构建期 seed 库

**Files:**
- Modify: `next.config.js`
- Modify: `tsconfig.json`
- Create: `scripts/ci-seed-db.mjs`

- [ ] **Step 1: 修改 next.config.js 增加 standalone 输出**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // ISR 配合 Vercel 自动处理，无需额外配置
  // workspace root：显式指向项目根，避免误检 /Users/zephyr/pnpm-workspace.yaml（多个 workspace 文件时 Next 推断错误）
  turbopack: {
    root: __dirname,
  },
  // 桌面端:产出自包含服务器(electron 主进程拉起 .next/standalone/server.js)
  output: 'standalone',
};

module.exports = nextConfig;
```

- [ ] **Step 2: tsconfig.json 的 exclude 增加 electron(避免 JS 进入 typecheck 输入)**

```json
  "exclude": [
    "node_modules",
    ".next",
    "electron"
  ]
```

- [ ] **Step 3: 创建 scripts/ci-seed-db.mjs**(构建期空库,含 verify-data 需要的 7 张表;仅构建用,运行时 initSchema 会建全表)

```js
#!/usr/bin/env node
/**
 * 构建期 seed 库:本地/CI 无数据文件时生成含关键表的空库,
 * 使 prebuild 的 verify-data.mjs 通过(桌面端构建不依赖远端 Turso)。
 * 用法:NEWS_DB_PATH=./seed/news_archive.db node scripts/ci-seed-db.mjs
 * 注意:仅建 verify-data 要求的关键表;运行时 lib/db.ts initSchema 会建全量表。
 */
import { createClient } from '@libsql/client';
import fs from 'fs';
import path from 'path';

const filePath = process.env.NEWS_DB_PATH || 'seed/news_archive.db';
fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });

const client = createClient({ url: `file:${path.resolve(filePath)}` });
await client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS news_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT, content TEXT NOT NULL,
    published_at TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    docurl TEXT, UNIQUE(source, source_id)
  );
  CREATE TABLE IF NOT EXISTS analysis_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    news_id INTEGER NOT NULL UNIQUE REFERENCES news_archive(id),
    signal_score INTEGER NOT NULL CHECK(signal_score BETWEEN 1 AND 5),
    category TEXT NOT NULL, impact_level TEXT NOT NULL,
    industries TEXT, companies TEXT, sentiment TEXT NOT NULL,
    summary TEXT NOT NULL, deep_analysis TEXT, tags TEXT, related_ids TEXT,
    event_thread_id TEXT, analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS event_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, news_ids TEXT NOT NULL, narrative TEXT NOT NULL,
    stage TEXT NOT NULL, confidence TEXT NOT NULL, industries TEXT, watch_points TEXT,
    dedup_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS market_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    trade_date TEXT NOT NULL, close REAL, change_pct REAL, volume REAL,
    UNIQUE(code, trade_date)
  );
  CREATE TABLE IF NOT EXISTS backtest_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_date TEXT NOT NULL, industry TEXT NOT NULL, signal_score INTEGER NOT NULL,
    signal_count INTEGER NOT NULL, day_1_return REAL, day_3_return REAL, day_7_return REAL,
    calculated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(signal_date, industry)
  );
  CREATE TABLE IF NOT EXISTS pipeline_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL, batch_id TEXT NOT NULL, retry_count INTEGER DEFAULT 0,
    status TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT, detail TEXT
  );
  CREATE TABLE IF NOT EXISTS pipeline_cursor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
console.log(`[ci-seed-db] ✓ 空库已建: ${filePath}`);
client.close();
```

- [ ] **Step 4: 生成 seed 库并验证 standalone 构建**

```bash
NEWS_DB_PATH=$PWD/seed/news_archive.db node scripts/ci-seed-db.mjs
NEWS_DB_PATH=$PWD/seed/news_archive.db pnpm build
```

Expected:
- seed 脚本输出 `✓ 空库已建`
- build 成功,`ls .next/standalone/server.js` 存在(若 Next 版本输出位置不同,以实际产物为准,记录实际路径供 Task 4 使用)

- [ ] **Step 5: seed 目录加入 .gitignore(库文件不入库)**

在 `.gitignore` 追加:

```
seed/
```

- [ ] **Step 6: Commit**

```bash
git add next.config.js tsconfig.json scripts/ci-seed-db.mjs .gitignore
git commit -m "build: next standalone 输出 + 构建期 seed 库脚本"
```

---

### Task 2: DESKTOP_MODE 鉴权放行

**Files:**
- Modify: `lib/cronAuth.ts`
- Modify: `proxy.ts`
- Test: `tests/cronAuth.test.ts`(追加用例)

- [ ] **Step 1: cronAuth.ts 增加 DESKTOP_MODE 放行(桌面端本地调度,无需 secret)**

在 `assertCronAuth` 函数体最前面加:

```ts
  // 桌面端本地调度:主进程调用自身服务,无需 secret
  if (process.env.DESKTOP_MODE === '1') return true;
```

- [ ] **Step 2: proxy.ts 增加 DESKTOP_MODE 放行(本地单用户,无会话)**

在 `export default async function proxy` 函数体最前面加:

```ts
  // 桌面端:本地单用户应用,跳过登录门卫
  if (process.env.DESKTOP_MODE === '1') return NextResponse.next();
```

- [ ] **Step 3: 追加测试到 tests/cronAuth.test.ts**

先读该文件了解现有用例结构,追加:

```ts
describe('DESKTOP_MODE', () => {
  it('bypasses auth when DESKTOP_MODE=1 even without secret', async () => {
    const prev = process.env.DESKTOP_MODE;
    process.env.DESKTOP_MODE = '1';
    try {
      const req = { query: {}, headers: {} };
      const res = { status: () => ({ json: () => {} }) };
      expect(await assertCronAuth(req, res)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_MODE;
      else process.env.DESKTOP_MODE = prev;
    }
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
pnpm test -- cronAuth
```

Expected: 现有用例 + 新用例全过(`CRON_SECRET not configured` 分支在 DESKTOP_MODE=1 时被短路,不再 503)

- [ ] **Step 5: Commit**

```bash
git add lib/cronAuth.ts proxy.ts tests/cronAuth.test.ts
git commit -m "feat: DESKTOP_MODE 跳过登录门卫与 cron 鉴权"
```

---

### Task 3: Electron 脚手架(依赖 + 最小主进程 + dev 冒烟)

**Files:**
- Modify: `package.json`
- Create: `electron/main.js`(最小版)
- Create: `electron/preload.js`(空壳)
- Create: `electron/notifier.js`(空壳占位,Task 9 填充)
- Create: `electron/tray.js`(空壳占位,Task 9 填充)
- Create: `electron/ipc.js`(空壳占位,Task 9 填充)
- Create: `electron/server.js`(空壳占位,Task 4/8 填充)
- Create: `electron/scheduler.js`(空壳占位,Task 8 填充)
- Create: `electron/store.js`(空壳占位,Task 7 填充)
- Create: `electron/import-db.js`(空壳占位,Task 7 填充)

- [ ] **Step 1: 安装依赖**

```bash
pnpm add -D electron electron-builder electron-updater concurrently cross-env
```

Expected: 安装成功(electron 会下载二进制,耗时较长)

- [ ] **Step 2: package.json 增加 main 字段与 scripts**

```json
  "main": "electron/main.js",
```

scripts 增加:

```json
    "dev:desktop": "concurrently -k -n web,app \"next dev --webpack -p 3010\" \"cross-env DESKTOP_MODE=1 electron .\"",
    "build:desktop": "pnpm build && node scripts/copy-standalone.mjs && electron-builder",
    "dist:dir": "pnpm build && node scripts/copy-standalone.mjs && electron-builder --dir"
```

(不用 wait-on:main.js 的 `loadUrlWithRetry` 在 Step 3 中轮询重试连接,next dev 就绪前窗口自动等待。)

- [ ] **Step 3: 创建 electron/main.js(最小版)**

```js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

const DEV_URL = 'http://127.0.0.1:3010';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Financial Signal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function loadUrlWithRetry(url, attempts = 60) {
  createWindow();
  const tryLoad = (n) => {
    if (!mainWindow) return;
    mainWindow.loadURL(url).catch(() => {
      if (n > 0) setTimeout(() => tryLoad(n - 1), 500);
    });
  };
  tryLoad(attempts);
}

app.whenReady().then(() => {
  loadUrlWithRetry(DEV_URL);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) loadUrlWithRetry(DEV_URL);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 4: 创建 electron/preload.js(空壳,Task 9 填充)**

```js
'use strict';
// 桌面端 IPC 桥(Task 9 填充)
```

- [ ] **Step 5: 创建其余空壳文件(各一行注释,标注填充任务)**

```bash
cd electron
for f in notifier tray ipc server scheduler store import-db; do
  printf "'use strict';\n// %s — 待 Task 填充\n" "$f" > "$f.js"
done
```

- [ ] **Step 6: dev 冒烟验证**

```bash
pnpm dev:desktop
```

Expected: next dev(3010)启动 → Electron 窗口出现并加载首页;若打开的是登录页(302),说明 DESKTOP_MODE 未生效——检查 dev:desktop 是否传了 env(Ctrl+C 终止)。

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml electron/
git commit -m "feat(electron): 脚手架与最小主进程(dev 模式连 next dev)"
```

---

### Task 4: server-utils(端口探测 / 健康检查 / spawn)

**Files:**
- Create: `electron/server-utils.js`
- Test: `tests/electron/server-utils.test.js`

- [ ] **Step 1: 写失败测试 tests/electron/server-utils.test.js**

```js
import { describe, it, expect, afterAll } from 'vitest'
import http from 'http'
import { findFreePort, waitForHealthy } from '../../electron/server-utils'

describe('findFreePort', () => {
  it('returns a port that is actually listenable', async () => {
    const port = await findFreePort()
    expect(typeof port).toBe('number')
    await new Promise((resolve, reject) => {
      const srv = http.createServer()
      srv.listen(port, '127.0.0.1', () => { srv.close(() => resolve()) })
      srv.on('error', reject)
    })
  })

  it('avoids an already-bound port', async () => {
    const taken = await findFreePort()
    const srv = http.createServer()
    await new Promise((r) => srv.listen(taken, '127.0.0.1', r))
    const next = await findFreePort()
    expect(next).not.toBe(taken)
    await new Promise((r) => srv.close(r))
  })
})

describe('waitForHealthy', () => {
  let srv
  let port
  beforeAll(async () => {
    port = await findFreePort()
    srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  })
  afterAll(async () => { if (srv) await new Promise((r) => srv.close(r)) })

  it('resolves when the URL starts returning', async () => {
    const ok = await waitForHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 3000, intervalMs: 50 })
    expect(ok).toBe(true)
  })

  it('times out for a dead port', async () => {
    const dead = await findFreePort()
    const ok = await waitForHealthy(`http://127.0.0.1:${dead}`, { timeoutMs: 400, intervalMs: 50 })
    expect(ok).toBe(false)
  })
})
```

(注意:若使用 globals:true 的现有配置,`beforeAll` 可用全局;`import { beforeAll }` 亦兼容。)

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- server-utils
```

Expected: FAIL(`Cannot find module '../../electron/server-utils'`)

- [ ] **Step 3: 实现 electron/server-utils.js**

```js
'use strict';
const net = require('net');
const http = require('http');

/** 找一个可监听的随机端口(127.0.0.1)。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询探测 URL 是否可访问(返回 2xx/3xx 即视为健康)。 */
function waitForHealthy(url, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 400) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tryOnce, intervalMs);
    };
    tryOnce();
  });
}

/** 生成 standalone server 的 spawn 参数。mode: 'dev' | 'prod' */
function buildServerEnv({ port, dbPath, extra = {} }) {
  return {
    ...process.env,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    DESKTOP_MODE: '1',
    NODE_ENV: 'production',
    ...(dbPath ? { NEWS_DB_PATH: dbPath } : {}),
    ...extra,
  };
}

module.exports = { findFreePort, waitForHealthy, buildServerEnv };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- server-utils
```

Expected: 4 个用例 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/server-utils.js tests/electron/server-utils.test.js
git commit -m "feat(electron): 端口探测与健康检查工具"
```

---

### Task 5: scheduler-core(调度序列 / LLM 判定 / 陈旧检测)

**Files:**
- Create: `electron/scheduler-core.js`
- Test: `tests/electron/scheduler-core.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest'
import {
  PIPELINE_JOBS,
  buildJobSequence,
  isLlmConfigured,
  isDataStale,
} from '../../electron/scheduler-core'

describe('buildJobSequence', () => {
  it('runs full pipeline when LLM configured', () => {
    expect(buildJobSequence({ llmConfigured: true })).toEqual(PIPELINE_JOBS)
  })

  it('runs fetch-only when LLM not configured', () => {
    expect(buildJobSequence({ llmConfigured: false })).toEqual(['fetch'])
  })
})

describe('isLlmConfigured', () => {
  it('true when llm_api_key set', () => {
    expect(isLlmConfigured({ llm_api_key: 'sk-xxx' })).toBe(true)
  })

  it('false when missing or empty', () => {
    expect(isLlmConfigured({})).toBe(false)
    expect(isLlmConfigured({ llm_api_key: '' })).toBe(false)
  })
})

describe('isDataStale', () => {
  const now = '2026-08-23T10:00:00Z'

  it('true when last fetch older than threshold', () => {
    expect(isDataStale('2026-08-23T07:30:00Z', now, 2 * 3600_000)).toBe(true)
  })

  it('false when fresh', () => {
    expect(isDataStale('2026-08-23T09:00:00Z', now, 2 * 3600_000)).toBe(false)
  })

  it('true when last fetch is null (never fetched)', () => {
    expect(isDataStale(null, now, 2 * 3600_000)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- scheduler-core
```

- [ ] **Step 3: 实现 electron/scheduler-core.js**

```js
'use strict';

/** 与 GitHub Actions 一致的管线顺序。 */
const PIPELINE_JOBS = ['fetch', 'analyze', 'deep-analyze', 'event-threads', 'fetch-market'];

/** 未配 LLM key 时只抓取不分析。 */
function buildJobSequence({ llmConfigured }) {
  return llmConfigured ? [...PIPELINE_JOBS] : ['fetch'];
}

/** 是否已配置 LLM(app_settings 的 llm_api_key 非空)。 */
function isLlmConfigured(settings) {
  return Boolean(settings && settings.llm_api_key);
}

/** 最近抓取是否超过阈值(未抓取过视为 stale)。 */
function isDataStale(lastFetchAt, nowIso, thresholdMs) {
  if (!lastFetchAt) return true;
  return Date.now() - Date.parse(lastFetchAt) > thresholdMs;
}

module.exports = { PIPELINE_JOBS, buildJobSequence, isLlmConfigured, isDataStale };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- scheduler-core
```

Expected: 8 个用例 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/scheduler-core.js tests/electron/scheduler-core.test.js
git commit -m "feat(electron): 调度序列与 LLM/数据陈旧判定"
```

---

### Task 6: notify-query(新增高分信号查询)

**Files:**
- Create: `electron/notify-query.js`
- Test: `tests/electron/notify-query.test.js`

- [ ] **Step 1: 写失败测试**(用临时文件 sqlite,不触碰 lib/db)

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient } from '@libsql/client'
import { queryNewHighSignals } from '../../electron/notify-query'

let dir, db, dbPath

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'))
  dbPath = path.join(dir, 'test.db')
  db = createClient({ url: `file:${dbPath}` })
  await db.executeMultiple(`
    CREATE TABLE news_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT, content TEXT NOT NULL,
      published_at TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE analysis_result (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id INTEGER NOT NULL UNIQUE REFERENCES news_archive(id),
      signal_score INTEGER NOT NULL,
      category TEXT NOT NULL, impact_level TEXT NOT NULL,
      industries TEXT, companies TEXT, sentiment TEXT NOT NULL,
      summary TEXT NOT NULL, analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
})

afterEach(async () => {
  await db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function insertNews(title, score, analyzedAt) {
  const n = await db.execute({
    sql: 'INSERT INTO news_archive (source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?)',
    args: ['sina', `s${Math.random()}`, title, 'content', '2026-08-23T09:00:00Z'],
  })
  const newsId = Number(n.lastInsertRowid)
  await db.execute({
    sql: `INSERT INTO analysis_result (news_id, signal_score, category, impact_level, sentiment, summary, analyzed_at)
          VALUES (?, ?, 'policy', 'significant', 'positive', ?, ?)`,
    args: [newsId, score, `summary-${title}`, analyzedAt],
  })
  return newsId
}

describe('queryNewHighSignals', () => {
  it('returns scored news with signal >= 4 after since', async () => {
    await insertNews('high-a', 5, '2026-08-23T10:00:00Z')
    await insertNews('low-b', 2, '2026-08-23T10:00:00Z')
    const rows = await queryNewHighSignals(db, '2026-08-23T09:00:00Z')
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('high-a')
    expect(rows[0].signalScore).toBe(5)
  })

  it('excludes rows analyzed at or before since', async () => {
    await insertNews('old-a', 5, '2026-08-23T08:00:00Z')
    const rows = await queryNewHighSignals(db, '2026-08-23T09:00:00Z')
    expect(rows).toHaveLength(0)
  })

  it('caps at limit', async () => {
    for (let i = 0; i < 5; i++) await insertNews(`batch-${i}`, 5, `2026-08-23T10:0${i}:00Z`)
    const rows = await queryNewHighSignals(db, '2026-08-23T09:00:00Z', 3)
    expect(rows).toHaveLength(3)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- notify-query
```

- [ ] **Step 3: 实现 electron/notify-query.js**

```js
'use strict';

/**
 * 查询 since 之后新完成分析的信号分 >= 4 的新闻(供桌面通知)。
 * db: @libsql client(调用方注入,测试用临时库)。
 */
async function queryNewHighSignals(db, sinceIso, limit = 20) {
  const r = await db.execute({
    sql: `SELECT n.id, n.title, a.signal_score, a.analyzed_at
          FROM analysis_result a
          JOIN news_archive n ON n.id = a.news_id
          WHERE a.signal_score >= 4 AND a.analyzed_at > ?
          ORDER BY a.analyzed_at DESC
          LIMIT ?`,
    args: [sinceIso, limit],
  });
  return r.rows.map((row) => ({
    newsId: Number(row.id),
    title: String(row.title || ''),
    signalScore: Number(row.signal_score),
    analyzedAt: String(row.analyzed_at),
  }));
}

module.exports = { queryNewHighSignals };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- notify-query
```

Expected: 3 个用例 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/notify-query.js tests/electron/notify-query.test.js
git commit -m "feat(electron): 高分信号通知查询"
```

---

### Task 7: store + import-db

**Files:**
- Create: `electron/store.js`
- Create: `electron/import-db.js`
- Test: `tests/electron/store.test.js`
- Test: `tests/electron/import-db.test.js`

- [ ] **Step 1: 写失败测试 tests/electron/store.test.js**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadConfig, saveConfig } from '../../electron/store'

let dir, file

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'))
  file = path.join(dir, 'config.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('returns defaults when file missing', () => {
    const cfg = loadConfig(file, { intervalMs: 1800000 })
    expect(cfg.intervalMs).toBe(1800000)
  })

  it('reads existing file and merges defaults', () => {
    fs.writeFileSync(file, JSON.stringify({ intervalMs: 600000 }))
    const cfg = loadConfig(file, { intervalMs: 1800000, notifyLastRunAt: null })
    expect(cfg.intervalMs).toBe(600000)
    expect(cfg).toHaveProperty('notifyLastRunAt')
  })

  it('falls back to defaults on corrupt file', () => {
    fs.writeFileSync(file, '{not json')
    const cfg = loadConfig(file, { intervalMs: 1800000 })
    expect(cfg.intervalMs).toBe(1800000)
  })
})

describe('saveConfig', () => {
  it('writes file readable by loadConfig', () => {
    saveConfig(file, { intervalMs: 900000, notifyLastRunAt: '2026-08-23T10:00:00Z' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      intervalMs: 900000,
      notifyLastRunAt: '2026-08-23T10:00:00Z',
    })
  })
})
```

- [ ] **Step 2: 写失败测试 tests/electron/import-db.test.js**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient } from '@libsql/client'
import { validateDbFile, importDbFile } from '../../electron/import-db'

let dir, goodPath, badPath

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'))
  goodPath = path.join(dir, 'good.db')
  const db = createClient({ url: `file:${goodPath}` })
  await db.executeMultiple(`
    CREATE TABLE news_archive (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  await db.close()
  badPath = path.join(dir, 'bad.db')
  fs.writeFileSync(badPath, 'this is not a sqlite database at all')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('validateDbFile', () => {
  it('accepts a db with required tables', async () => {
    const r = await validateDbFile(goodPath)
    expect(r.ok).toBe(true)
  })

  it('rejects a non-sqlite file', async () => {
    const r = await validateDbFile(badPath)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('rejects a missing file', async () => {
    const r = await validateDbFile(path.join(dir, 'nope.db'))
    expect(r.ok).toBe(false)
  })
})

describe('importDbFile', () => {
  it('copies file to destination only when valid', async () => {
    const dest = path.join(dir, 'copied.db')
    const r = await importDbFile(goodPath, dest)
    expect(r.ok).toBe(true)
    expect(fs.existsSync(dest)).toBe(true)
  })

  it('does not copy an invalid file', async () => {
    const dest = path.join(dir, 'copied2.db')
    const r = await importDbFile(badPath, dest)
    expect(r.ok).toBe(false)
    expect(fs.existsSync(dest)).toBe(false)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm test -- store import-db
```

- [ ] **Step 4: 实现 electron/store.js**

```js
'use strict';
const fs = require('fs');
const path = require('path');

/** 读取 config.json;文件缺失/损坏时返回 defaults。 */
function loadConfig(file, defaults) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

/** 原子写入 config.json。 */
function saveConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { loadConfig, saveConfig };
```

- [ ] **Step 5: 实现 electron/import-db.js**

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const REQUIRED_TABLES = ['news_archive', 'app_settings'];

/** 校验 db 文件:可打开且含必要表。返回 { ok, error? } */
async function validateDbFile(file) {
  try {
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    const client = createClient({ url: `file:${file}` });
    try {
      for (const table of REQUIRED_TABLES) {
        const r = await client.execute({
          sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          args: [table],
        });
        if (r.rows.length === 0) {
          return { ok: false, error: `缺少必要表: ${table}` };
        }
      }
      return { ok: true };
    } finally {
      await client.close();
    }
  } catch (err) {
    return { ok: false, error: `无法打开数据库: ${err.message}` };
  }
}

/** 校验通过后复制到目标路径。返回 { ok, error? } */
async function importDbFile(src, dest) {
  const v = await validateDbFile(src);
  if (!v.ok) return v;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `复制失败: ${err.message}` };
  }
}

module.exports = { validateDbFile, importDbFile };
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm test -- store import-db
```

Expected: 全部 PASS(store 4 个 + import-db 5 个)

- [ ] **Step 7: Commit**

```bash
git add electron/store.js electron/import-db.js tests/electron/store.test.js tests/electron/import-db.test.js
git commit -m "feat(electron): 配置存储与 db 导入校验"
```

---

### Task 8: main.js 完整集成(server 拉起 / 调度驱动 / 单实例 / 崩溃重启)

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/server.js`(填充)
- Modify: `electron/scheduler.js`(填充)

- [ ] **Step 1: 填充 electron/server.js**(dev 模式不 spawn;prod 模式 spawn standalone,健康检查、崩溃重启)

```js
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { findFreePort, waitForHealthy, buildServerEnv } = require('./server-utils');

const MAX_RESTARTS = 5;
const STANDALONE_DIR = path.join(__dirname, '..', '.next', 'standalone');

let child = null;
let restarts = 0;
let currentUrl = null;

/** dev 模式返回固定 URL(next dev 由 dev:desktop 脚本管理)。 */
function devUrl() {
  return 'http://127.0.0.1:3010';
}

/** prod 模式:选端口 → spawn standalone → 等健康 → 返回 baseUrl。 */
async function startServer({ dbPath, onCrash }) {
  const port = await findFreePort();
  const serverJs = path.join(STANDALONE_DIR, 'server.js');
  const env = buildServerEnv({ port, dbPath });

  child = spawn('node', [serverJs], {
    cwd: STANDALONE_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.stdout.on('data', (d) => {
    const line = String(d).trim();
    if (line && !line.startsWith('✓')) process.stdout.write(`[server] ${line}\n`);
  });

  child.on('exit', (code) => {
    child = null;
    if (restarts < MAX_RESTARTS) {
      restarts += 1;
      const delay = Math.min(1000 * 2 ** restarts, 30000);
      console.log(`[server] exited(${code}), restart in ${delay}ms (${restarts}/${MAX_RESTARTS})`);
      setTimeout(() => startServer({ dbPath, onCrash }).then(onCrash).catch(() => {}), delay);
    } else {
      console.error('[server] too many crashes, giving up');
    }
  });

  const url = `http://127.0.0.1:${port}`;
  currentUrl = url;
  const healthy = await waitForHealthy(`${url}/api/health`);
  if (!healthy) throw new Error('standalone server did not become healthy');
  return url;
}

/** 当前 server 的 baseUrl(未启动返回 null)。 */
function serverBaseUrl() {
  return currentUrl;
}

module.exports = { startServer, devUrl, serverBaseUrl };
```

- [ ] **Step 2: 填充 electron/scheduler.js**

```js
'use strict';
const http = require('http');
const { buildJobSequence, isLlmConfigured, isDataStale } = require('./scheduler-core');
const { loadConfig, saveConfig } = require('./store');
const { getSettings } = require('./app-settings');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

function callCron(baseUrl, job) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/cron/${job}`, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) return resolve(true);
      resolve(false);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error(`cron ${job} timeout`)); });
  });
}

/** 创建调度器:每 intervalMs 跑一轮管线;启动时数据过期则立即补跑 fetch。 */
function createScheduler({ baseUrl, dbPath, configFile, onRunStart, onRunEnd }) {
  const cfg = loadConfig(configFile, { intervalMs: DEFAULT_INTERVAL_MS, notifyLastRunAt: null });
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const settings = await getSettings(dbPath);
      const sequence = buildJobSequence({ llmConfigured: isLlmConfigured(settings) });
      if (onRunStart) onRunStart(sequence);
      for (const job of sequence) {
        const ok = await callCron(baseUrl, job);
        if (!ok) console.log(`[scheduler] ${job} skipped/failed`);
      }
      if (onRunEnd) onRunEnd();
    } catch (err) {
      console.error('[scheduler] run failed:', err.message);
    } finally {
      running = false;
    }
  }

  async function bootstrapIfStale(getLastFetchAt) {
    if (isDataStale(getLastFetchAt(), new Date().toISOString(), cfg.intervalMs)) {
      await callCron(baseUrl, 'fetch');
    }
  }

  function start() {
    timer = setInterval(() => { runOnce().catch(() => {}); }, cfg.intervalMs);
    timer.unref();
    return runOnce().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce, bootstrapIfStale };
}

module.exports = { createScheduler, callCron, DEFAULT_INTERVAL_MS };
```

(注意:引用了 `./app-settings` — 需创建该模块,见 Step 3。)

- [ ] **Step 3: 创建 electron/app-settings.js**(读 app_settings 表,供调度器判断 LLM 配置)

```js
'use strict';
const { createClient } = require('@libsql/client');

/** 读 app_settings 表全量键值(不依赖 Web 侧 lib/settings.ts 缓存)。 */
async function getSettings(dbPath) {
  if (!dbPath) return {};
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const r = await client.execute({ sql: 'SELECT key, value FROM app_settings', args: [] });
    const out = {};
    for (const row of r.rows) out[String(row.key)] = String(row.value);
    return out;
  } catch {
    return {};
  } finally {
    await client.close();
  }
}

module.exports = { getSettings };
```

- [ ] **Step 4: 重写 electron/main.js 为完整版**

```js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer, devUrl } = require('./server');
const { createScheduler } = require('./scheduler');
const { loadConfig } = require('./store');
const { isLlmConfigured } = require('./scheduler-core');
const { getSettings } = require('./app-settings');

let mainWindow = null;
let serverUrl = null;
let scheduler = null;

const isDev = !app.isPackaged;
const userData = app.getPath('userData');
const dbPath = path.join(userData, 'news_archive.db');
const configFile = path.join(userData, 'config.json');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Financial Signal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function navigate() {
  if (!mainWindow) return;
  mainWindow.loadURL(serverUrl || devUrl()).catch(() => {
    setTimeout(navigate, 500);
  });
}

async function startScheduler() {
  if (!serverUrl || scheduler) return;
  scheduler = createScheduler({
    baseUrl: serverUrl,
    dbPath,
    configFile,
    onRunStart: (sequence) => console.log(`[scheduler] run: ${sequence.join(' → ')}`),
  });
  scheduler.start();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const url = isDev ? devUrl() : await startServer({ dbPath, onCrash: () => navigate() });
    serverUrl = url;
    createWindow();
    navigate();
    if (!isDev) startScheduler();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        navigate();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
```

- [ ] **Step 5: 类型自检**

```bash
pnpm typecheck
```

Expected: 无新增错误(electron/ 已排除;app-settings.js 无引用问题)

- [ ] **Step 6: 单元回归**

```bash
pnpm test
```

Expected: 全过(175 + 新增)

- [ ] **Step 7: Commit**

```bash
git add electron/main.js electron/server.js electron/scheduler.js electron/app-settings.js
git commit -m "feat(electron): 主进程集成(standalone 拉起/调度/单实例/重启)"
```

---

### Task 9: 托盘 + 通知 + IPC + preload 完整版

**Files:**
- Modify: `electron/tray.js`、`electron/notifier.js`、`electron/ipc.js`、`electron/preload.js`
- Modify: `electron/main.js`(挂接托盘/通知/IPC)

- [ ] **Step 1: 填充 electron/notifier.js**

```js
'use strict';
const { Notification } = require('electron');
const { createClient } = require('@libsql/client');
const { queryNewHighSignals } = require('./notify-query');
const { loadConfig, saveConfig } = require('./store');

/** 分析完成后查询新增高分信号并推送;返回推送条数。 */
async function notifyNewHighSignals({ dbPath, configFile, onActivate }) {
  const cfg = loadConfig(configFile, { notifyLastRunAt: null });
  const since = cfg.notifyLastRunAt || '2000-01-01T00:00:00Z';
  const client = createClient({ url: `file:${dbPath}` });
  let rows;
  try {
    rows = await queryNewHighSignals(client, since);
  } finally {
    await client.close();
  }
  if (rows.length > 0) {
    for (const row of rows.slice(0, 5)) {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: `信号 ${row.signalScore} 分: ${row.title.slice(0, 40)}`,
          body: row.title,
        });
        n.on('click', () => { if (onActivate) onActivate(); });
        n.show();
      }
    }
  }
  const newest = rows[0] ? rows[0].analyzedAt : cfg.notifyLastRunAt;
  saveConfig(configFile, { ...cfg, notifyLastRunAt: newest || cfg.notifyLastRunAt });
  return rows.length;
}

module.exports = { notifyNewHighSignals };
```

- [ ] **Step 2: 填充 electron/tray.js**

```js
'use strict';
const { Tray, Menu, app } = require('electron');
const path = require('path');

let tray = null;

function createTray({ onOpen, onFetchNow, onOpenDataDir, onCheckUpdate, onQuit }) {
  tray = new Tray(path.join(__dirname, '..', 'public', 'logo.png'));
  tray.setToolTip('Financial Signal');
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: onOpen },
    { label: '立即抓取', click: onFetchNow },
    { label: '打开数据目录', click: onOpenDataDir },
    ...(onCheckUpdate ? [{ label: '检查更新…', click: onCheckUpdate }] : []),
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', onOpen);
  return tray;
}

module.exports = { createTray };
```

(注意:`public/logo.png` 在打包时随 public/ 拷入;若缺失,createTray 会抛错——实现时确认 public/ 下有 png 图标,否则用 `nativeImage.createEmpty()` 兜底。)

- [ ] **Step 3: 填充 electron/ipc.js 与 electron/preload.js**

```js
// electron/ipc.js
'use strict';
const { ipcMain, dialog, shell, app } = require('electron');
const path = require('path');
const { validateDbFile, importDbFile } = require('./import-db');

function registerIpc({ getConfigFile, getDbPath, onImported, onFetchNow }) {
  ipcMain.handle('app:select-and-import-db', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择要导入的 news_archive.db',
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    const src = filePaths[0];
    const dest = getDbPath();
    const r = await importDbFile(src, dest);
    if (r.ok && onImported) onImported();
    return r;
  });

  ipcMain.handle('app:open-data-dir', () => {
    shell.openPath(path.dirname(getDbPath()));
  });

  ipcMain.handle('app:get-info', () => ({
    version: app.getVersion(),
    dbPath: getDbPath(),
    imported: require('fs').existsSync(getDbPath()),
  }));

  ipcMain.handle('app:fetch-now', async () => {
    if (onFetchNow) await onFetchNow();
    return { ok: true };
  });
}

module.exports = { registerIpc };
```

```js
// electron/preload.js
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  selectAndImportDb: () => ipcRenderer.invoke('app:select-and-import-db'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  fetchNow: () => ipcRenderer.invoke('app:fetch-now'),
});
```

- [ ] **Step 4: main.js 挂接(在 `startScheduler` 与 `app.whenReady` 处插入)**

- 引入 `createTray`、`registerIpc`、`notifyNewHighSignals`、`shell`
- `startScheduler` 的 `onRunEnd` 中调用 `notifyNewHighSignals({ dbPath, configFile, onActivate: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } })`
- `app.whenReady` 中 `registerIpc({...})` + `createTray({ onOpen: ..., onFetchNow: () => scheduler.runOnce(), onOpenDataDir: ... })`
- 托盘 `onQuit`: `app.isQuitting = true; app.quit()`

(实现时按现有 main.js 实际代码位置插入,保持结构一致。)

- [ ] **Step 5: 手动冒烟(dev 模式)**

```bash
pnpm dev:desktop
```

验证清单:
- 托盘图标出现,菜单项齐全
- 首页 `window.desktop.getInfo()` 返回版本与 db 路径(DevTools Console 执行)
- 托盘"立即抓取"触发一轮管线(观察 [server] 日志)

- [ ] **Step 6: Commit**

```bash
git add electron/tray.js electron/notifier.js electron/ipc.js electron/preload.js electron/main.js
git commit -m "feat(electron): 托盘/通知/IPC 桥"
```

---

### Task 10: 首次引导欢迎页

**Files:**
- Create: `components/WelcomeScreen.tsx`
- Modify: `pages/index.tsx`(桌面端未导入 db 时显示欢迎页)
- Test: `tests/components/welcome.test.tsx`

- [ ] **Step 1: 写失败测试 tests/components/welcome.test.tsx**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import WelcomeScreen from '../../components/WelcomeScreen'

describe('WelcomeScreen', () => {
  it('renders two actions: import and skip', () => {
    render(<WelcomeScreen onImport={() => {}} onSkip={() => {}} importing={false} error={null} />)
    expect(screen.getByText(/导入已有数据库/i)).toBeTruthy()
    expect(screen.getByText(/全新开始/i)).toBeTruthy()
  })

  it('calls onImport when clicking import button', () => {
    const onImport = vi.fn()
    render(<WelcomeScreen onImport={onImport} onSkip={() => {}} importing={false} error={null} />)
    fireEvent.click(screen.getByText(/导入已有数据库/i))
    expect(onImport).toHaveBeenCalledTimes(1)
  })

  it('shows error message when import fails', () => {
    render(<WelcomeScreen onImport={() => {}} onSkip={() => {}} importing={false} error="文件格式不正确" />)
    expect(screen.getByText(/文件格式不正确/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- welcome
```

- [ ] **Step 3: 实现 components/WelcomeScreen.tsx**

```tsx
import { useState } from 'react';

interface Props {
  onImport: () => void;
  onSkip: () => void;
  importing: boolean;
  error: string | null;
}

export default function WelcomeScreen({ onImport, onSkip, importing, error }: Props) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold">欢迎使用 Financial Signal</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          桌面端使用本地数据库存储新闻与信号分析。你可以导入已有的 news_archive.db,
          或全新开始由应用自动抓取。
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <button
            className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
            onClick={onImport}
            disabled={importing}
          >
            {importing ? '导入中…' : '导入已有数据库'}
          </button>
          <button
            className="rounded-lg border px-4 py-2"
            onClick={onSkip}
            disabled={importing}
          >
            全新开始
          </button>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- welcome
```

- [ ] **Step 5: 集成到 pages/index.tsx(仅桌面端且未导入时展示)**

在文件顶部加状态与判定(实现时贴合现有页面结构):

```tsx
const [showWelcome, setShowWelcome] = useState(false);
const [importing, setImporting] = useState(false);
const [importError, setImportError] = useState<string | null>(null);

useEffect(() => {
  const win = (window as any).desktop;
  if (win?.getInfo) {
    win.getInfo().then((info: any) => {
      if (!info.imported) setShowWelcome(true);
    });
  }
}, []);

const handleImport = async () => {
  const win = (window as any).desktop;
  if (!win) return;
  setImporting(true);
  setImportError(null);
  const r = await win.selectAndImportDb();
  setImporting(false);
  if (r?.ok) setShowWelcome(false);
  else if (!r?.canceled) setImportError(r?.error || '导入失败');
};
```

渲染处: `if (showWelcome) return <WelcomeScreen onImport={handleImport} onSkip={() => setShowWelcome(false)} importing={importing} error={importError} />;`

- [ ] **Step 6: 手动冒烟(dev 模式,userData 无 db 的干净状态)**

```bash
pnpm dev:desktop
```

Expected: 首启显示欢迎页;点"全新开始"进入首页;再启动不显示欢迎页(userData 已建空库——确认 main.js 在跳过后创建空库,若未创建则 `getInfo.imported` 仍为 false。实现时 main.js 的 `onImported` 与 skip 路径都要确保 db 文件存在:可在 navigate 前调 `importDbFile` 之外,由 lib/db.ts 惰性建库——需要 main.js 在跳过时主动触碰一次 db(如执行一次 `getSettings(dbPath)`),记录为"全新开始"处理)。**实现决策**:全新开始时 main.js 创建空 db 文件(`createClient(file:).execute('SELECT 1')`),然后 `getInfo.imported` 才为 true。

- [ ] **Step 7: Commit**

```bash
git add components/WelcomeScreen.tsx pages/index.tsx tests/components/welcome.test.tsx electron/main.js
git commit -m "feat: 首次引导欢迎页(db 导入/全新开始)"
```

---

### Task 11: 打包配置 + 本地产物验证

**Files:**
- Create: `scripts/copy-standalone.mjs`
- Create: `electron-builder.yml`
- Modify: `package.json`(postbuild 说明与 build:desktop 已有)

- [ ] **Step 1: 创建 scripts/copy-standalone.mjs**

```js
#!/usr/bin/env node
/**
 * standalone 产物补齐:Next standalone 不包含 public/ 与 .next/static,
 * 需拷入 .next/standalone 供打包(server 以 standalone 目录为 cwd 提供静态资源)。
 */
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');

for (const [from, to] of [
  [path.join(root, 'public'), path.join(standalone, 'public')],
  [path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static')],
]) {
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, to, { recursive: true });
  console.log(`[copy-standalone] ✓ ${path.relative(root, from)} → ${path.relative(root, to)}`);
}
```

- [ ] **Step 2: 创建 electron-builder.yml**

```yaml
appId: com.zephyr.financial-signal
productName: Financial Signal
directories:
  output: dist
files:
  - electron/**
  - .next/standalone/**/*
  - package.json
  - "!node_modules/**"
asar: true
asarUnpack:
  - "**/node_modules/@libsql/**"
  - "**/node_modules/@libsql/client/**"
mac:
  target:
    - target: dmg
    - target: zip
  category: public.app-category.finance
  # 无证书时注释以下两行即可本地构建
  # identity: null
win:
  target:
    - target: nsis
      arch: [x64]
linux:
  target:
    - AppImage
    - deb
  category: Finance
  maintainer: zephyr
publish:
  provider: github
  owner: zephyr110
  repo: financial-signal
```

- [ ] **Step 3: 本地打包验证(mac)**

```bash
NEWS_DB_PATH=$PWD/seed/news_archive.db pnpm dist:dir
```

Expected: `dist/mac*/Financial Signal.app` 生成;`app.asar` 内含 `.next/standalone/server.js` 与 `public/`

```bash
ls dist/mac-arm64/Financial\ Signal.app/Contents/Resources/app.asar
npx asar list dist/mac-arm64/Financial\ Signal.app/Contents/Resources/app.asar | grep -E "standalone/server.js|logo.png" | head -5
```

- [ ] **Step 4: 启动打包产物冒烟**

```bash
open "dist/mac-arm64/Financial Signal.app"
```

Expected: 应用启动 → 内置 server 拉起到随机端口 → 首页加载(托盘出现)。首次启动会创建 `~/Library/Application Support/financial-signal/`(appId 决定)下空库。

- [ ] **Step 5: Commit**

```bash
git add scripts/copy-standalone.mjs electron-builder.yml
git commit -m "build(electron): 打包配置与 standalone 产物补齐"
```

---

### Task 12: 自动更新接入

**Files:**
- Create: `electron/updater.js`
- Modify: `electron/main.js`(挂接)

- [ ] **Step 1: 创建 electron/updater.js**

```js
'use strict';
const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');

let checkedOnce = false;

/** 启动后静默检查一次;托盘手动检查会弹进度。 */
function initUpdater({ manual = false } = {}) {
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', async (info) => {
    if (manual) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['下载', '稍后'],
        defaultId: 0,
        message: `发现新版本 ${info.version}`,
      });
      if (response !== 0) return;
    }
    await autoUpdater.downloadUpdate();
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      message: `新版本 ${info.version} 已下载,重启后生效`,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('update-not-available', () => {
    if (manual) dialog.showMessageBox({ type: 'info', message: '已是最新版本' });
  });
  autoUpdater.on('error', (err) => {
    if (manual) dialog.showMessageBox({ type: 'error', message: `检查更新失败: ${err.message}` });
  });
  if (!checkedOnce && !manual) {
    checkedOnce = true;
    autoUpdater.checkForUpdates().catch(() => {});
  }
  if (manual) autoUpdater.checkForUpdates().catch(() => {});
}

module.exports = { initUpdater };
```

- [ ] **Step 2: main.js 挂接**

- `const { initUpdater } = require('./updater');`
- `app.whenReady` 中(仅 `!isDev`):`initUpdater()`
- tray 的 `onCheckUpdate` 传 `() => initUpdater({ manual: true })`

- [ ] **Step 3: 冒烟(打包产物)**

手动验证:打包产物启动无报错;托盘"检查更新"在无 Releases 时弹"已是最新版本"(可先 `gh release list` 确认仓库有无 release,有则验证更新流)。

- [ ] **Step 4: Commit**

```bash
git add electron/updater.js electron/main.js
git commit -m "feat(electron): 自动更新(electron-updater)"
```

---

### Task 13: CI 发布工作流 + README

**Files:**
- Create: `.github/workflows/desktop-release.yml`
- Modify: `README.md`

- [ ] **Step 1: 创建 .github/workflows/desktop-release.yml**

```yaml
name: Desktop Release

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:
    inputs:
      version:
        description: "版本标签(如 v2.1.0),同时 push tag 触发"
        required: false

jobs:
  build:
    name: Build (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11.14.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # 构建期需要含关键表的 db(不依赖远端 Turso)
      - run: node scripts/ci-seed-db.mjs
        env:
          NEWS_DB_PATH: ${{ github.workspace }}/seed/news_archive.db
      - run: pnpm build
        env:
          NEWS_DB_PATH: ${{ github.workspace }}/seed/news_archive.db
      - run: node scripts/copy-standalone.mjs
      - name: Package
        run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # 无签名证书时跳过 mac notarization
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
      - uses: actions/upload-artifact@v4
        with:
          name: dist-${{ matrix.os }}
          path: dist/**
```

- [ ] **Step 2: README 增加桌面端章节**(追加在 Deployment 之前)

```markdown
## Desktop App (Electron)

离线自给自足的桌面端:内置抓取 + LLM 分析管线、本地 SQLite、托盘通知与自动更新,不依赖远程服务器。

- **开发**: `pnpm dev:desktop`(next dev + Electron 窗口)
- **打包(本地 mac)**: `NEWS_DB_PATH=./seed/news_archive.db pnpm dist:dir`
- **发布**: push `v*` tag,CI 三平台打包上传 GitHub Releases
- **数据目录**: macOS `~/Library/Application Support/financial-signal/`、Windows `%APPDATA%/financial-signal`、Linux `~/.config/financial-signal`
- **首次启动**: 可导入现有 `news_archive.db` 或全新开始;在设置弹窗配置 LLM key 后分析管线自动启用

桌面端新增代码集中在 `electron/` 与 `scripts/`,Web 侧仅 `proxy.ts`/`cronAuth.ts` 增加 DESKTOP_MODE 放行、`next.config.js` 增加 standalone 输出。
```

- [ ] **Step 3: 语法校验 YAML**

```bash
node -e "const y=require('yaml');const fs=require('fs');y.parse(fs.readFileSync('.github/workflows/desktop-release.yml','utf8'));console.log('yaml ok')"
```

(若 `yaml` 包未安装,用 `npx --yes yaml-lint .github/workflows/desktop-release.yml` 代替。)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/desktop-release.yml README.md
git commit -m "ci: 桌面端三平台发布工作流 + README 文档"
```

---

### Task 14: 收尾验证(全量回归 + 冒烟清单)

**Files:** 无(纯验证)

- [ ] **Step 1: 全量测试 + 类型检查**

```bash
pnpm test && pnpm typecheck
```

Expected: 全部测试通过(175 + 新增),typecheck 无错误

- [ ] **Step 2: 构建 + 打包冒烟**

```bash
NEWS_DB_PATH=$PWD/seed/news_archive.db pnpm build
node scripts/copy-standalone.mjs
```

Expected: build 成功,standalone 产物完整(public + static 已拷入)

- [ ] **Step 3: 手工冒烟清单(打包产物)**

- [ ] 首次启动显示欢迎页 → 导入现有 db → 首页出现历史新闻
- [ ] 全新开始 → 配置 LLM key → 手动抓取 → 分析 → 信号 ≥4 推送通知
- [ ] 托盘菜单全部可用;点击通知聚焦窗口
- [ ] 应用退出后内置 server 进程不残留(`ps aux | grep standalone`)
- [ ] 崩溃重启:kill server 子进程后 30s 内自动恢复

- [ ] **Step 4: 更新 git 历史备注**(可选):`git log --oneline` 核对每个 Task 一个提交
