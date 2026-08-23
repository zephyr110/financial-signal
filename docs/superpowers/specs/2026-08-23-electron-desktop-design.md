# Electron 桌面端设计文档

- 日期:2026-08-23
- 状态:已批准(brainstorming 完成)
- 分支:`feat/electron-desktop`

## 背景与目标

为 financial-signal(新浪财经新闻 RSS + LLM 信号分析,Next.js 16 Pages Router + ISR)增加桌面端。

目标:
- **离线自给自足**:桌面端自带抓取 + LLM 分析管线,本地 SQLite 存储,不依赖远程 Vercel/Turso/GitHub Actions
- **分发给他人**:三平台打包(macOS + Windows + Linux),首次启动引导配置,自动更新
- **复用现有代码**:Web 页面、管线、设置体系几乎零改动

## 方案对比与选择

| 方案 | 思路 | 结论 |
|------|------|------|
| A:静态导出 | `next export` + Electron 壳,全部改客户端数据获取 | 重写数据层,工作量 3 倍以上,破坏 Web 版架构,弃 |
| **B:standalone + Electron(选定)** | `output: 'standalone'` 自包含服务,Electron 主进程拉起本地服务器 | 复用 100% 现有代码,改动收敛在 electron/ 目录 |
| C:Tauri | Rust 壳 + 系统 WebView | 偏离指定技术栈,三平台 WebView 兼容坑多,弃 |

**版本锁定(2026-08 当前最新)**:Electron 43.x、electron-builder 26.x、electron-updater 6.x。
**安全默认**:`contextIsolation: true` + `sandbox: true` + preload 桥,渲染进程不接触 Node。

## 架构总览

```
┌────────────────────────────────────────────────┐
│ Electron 主进程 (main)                           │
│  ├─ 单实例锁 (requestSingleInstanceLock)        │
│  ├─ 拉起 standalone server (child_process)      │
│  ├─ 健康检查 + 崩溃自动重启 + 随机端口           │
│  ├─ 调度器:定时调 /api/cron/* (可配间隔)         │
│  ├─ 托盘:打开窗口 / 立即抓取 / 退出              │
│  ├─ 通知:分析完成后新信号 ≥4 推送                │
│  └─ IPC:设置读写、导入 db、窗口控制              │
├────────────────────────────────────────────────┤
│ BrowserWindow (contextIsolation + preload)      │
│   └─ http://127.0.0.1:<随机端口>                │
│        └─ Next.js standalone(全部页面/API 复用)  │
├────────────────────────────────────────────────┤
│ 数据:userData/news_archive.db (SQLite)          │
│ 设置:userData/config.json (Electron 层)         │
└────────────────────────────────────────────────┘
```

- 数据目录 `app.getPath('userData')`(macOS `~/Library/Application Support/financial-signal/`、Windows `%APPDATA%`、Linux `~/.config`),通过 `NEWS_DB_PATH` env 传给 standalone server。现有 `lib/db.ts` 本地分支零改动
- 登录门卫:`proxy.ts` 加 `DESKTOP_MODE=1` 判定直接放行(本地单用户,无会话)

## 模块分解(electron/ 目录)

| 文件 | 职责 |
|------|------|
| `main.js` | 窗口、单实例锁、生命周期、app 事件 |
| `server.js` | standalone server 管理:spawn、随机端口探测、健康检查、崩溃重启(指数退避,最多 5 次) |
| `scheduler.js` | 定时调度循环,调本地 `/api/cron/*`;间隔可配,默认 30 分钟 |
| `tray.js` | 托盘菜单:打开主窗口 / 立即抓取 / 打开数据目录 / 检查更新 / 退出 |
| `notifier.js` | 分析完成后查询新增信号 ≥4 的新闻,去重推送(记录上次推送时间戳) |
| `store.js` | `config.json` 读写:窗口状态、调度间隔、导入状态 |
| `import-db.js` | db 导入校验逻辑(纯函数,可单测) |
| `preload.js` + `ipc.js` | IPC 桥:设置读写、导入 db、窗口控制 |

主进程逻辑全部抽成可测纯函数(依赖注入 server 句柄、db 路径),不启动真实 Electron 即可单测。

## 调度器与管线

- 现有 `pages/api/cron/` 全套接口(fetch / analyze / deep-analyze / event-threads / fetch-market)通过本地 HTTP 复用,`DESKTOP_MODE` 下跳过 CRON_SECRET 鉴权
- 现有 `batch_id` 小时去重机制天然防重复分析;失败下轮自然重试
- 启动时若最近一次抓取超过 2 小时,自动补跑一轮 fetch
- 未配 LLM key:只跑 fetch 不跑 analyze,页面降级可用,设置里提示

## 托盘与通知

- 通知规则:每轮 analyze 完成后,查询该时间窗内新增信号分 ≥4 的新闻推送;记录时间戳去重,不重复轰炸
- 点击通知:聚焦窗口并打开对应新闻
- Linux 无通知守护时静默降级,托盘红点提示

## 数据导入(首次启动)

- 欢迎页:导入现有 `news_archive.db` 或"全新开始"
- 流程:选文件 → 校验(必含 `news_archive` 等必要表,只读打开测试)→ 复制到 userData → 重启内置 server → 失败保留原文件并报错
- 现有 db 为 @libsql `file:` 格式,直接兼容,零迁移

## 设置持久化

- LLM key / base_url / model 继续走现有 `app_settings` 表(存于 userData 的 db),设置弹窗界面零改动,热生效(30s 缓存)
- `config.json` 只存 Electron 层数据(窗口状态、调度间隔、导入状态)

## 打包 / CI / 测试

**打包**(electron-builder 26):macOS `.dmg`(+zip 供更新,建议签名 + notarization)、Windows NSIS `.exe`(无证书则 SmartScreen 警告)、Linux AppImage + deb。包内容:standalone server + Electron 43 + `public/`;注意 standalone 模式下 `public/` 与 `.next/static` 需手动拷入产物。预计体积 ~100–150MB。

**自动更新**:electron-updater,发布 GitHub Releases,启动后台检查 + 托盘手动检查,下载后提示重启安装。

**CI**:GitHub Actions 三平台矩阵打包上传 Releases;现有 typecheck / vitest / prebuild 校验照常跑。

**测试**:单元(vitest)覆盖调度去重、通知查询、导入校验;手动冒烟(启动 → 导入 → 抓取 → 分析 → 通知 → 托盘 → 更新)。E2E(playwright-electron)可选,不进 MVP。

## 改动文件清单

```
新增:
  electron/main.js  electron/server.js  electron/scheduler.js
  electron/tray.js  electron/notifier.js  electron/store.js
  electron/preload.js  electron/ipc.js  electron/import-db.js
  首次引导(欢迎页)相关页面组件
修改:
  next.config.js        output: 'standalone'
  proxy.ts              DESKTOP_MODE 跳过鉴权
  package.json          新增 electron 相关 scripts
  .github/workflows/    新增打包发布工作流
```

## 非目标(YAGNI)

- 不做 E2E 测试(列为可选)
- 不做多用户/登录体系(本地单用户)
- 不做 remote 同步(桌面端与 Web 端数据互不同步)
- 不做 Windows 代码签名证书采购(可选配置)
- 不做 deep-link 协议注册
