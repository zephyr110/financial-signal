'use strict';
const http = require('http');
const fs = require('fs');
const {
  buildJobSequence, isLlmConfigured, COCKPIT_DAILY_JOB, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS,
} = require('./scheduler-core');
const { loadConfig } = require('./store');
const { getSettings: getAppSettings } = require('./app-settings');

// 启动后延迟首轮:崩溃重启/换库后立刻全量跑会与旧实例在途轮次重叠,
// 对同一批未分析新闻重复发起 LLM 调用。托盘"立即抓取"不受此延迟影响。
const FIRST_RUN_DELAY_MS = 15 * 1000;

/** 非数值/0/负数间隔回退默认值,否则 Math.max 会得到 NaN,setInterval 按 ~1ms 连轴跑。 */
function normalizeIntervalMs(raw, minIntervalMs = MIN_INTERVAL_MS) {
  const n = Number(raw);
  return Math.max(minIntervalMs, Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS);
}

function getJson(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = http.get(url, { headers: { Origin: new URL(url).origin } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return finish(reject, new Error(`GET ${url} -> ${res.statusCode}`));
        }
        try {
          finish(resolve, body ? JSON.parse(body) : null);
        } catch (err) {
          finish(reject, err);
        }
      });
      // 响应头已到但连接中途断开时,req 不会再报错/超时;不监听这里 promise 会永挂。
      res.on('error', (err) => finish(reject, err));
      res.on('close', () => {
        if (!res.complete) finish(reject, new Error(`GET ${url} aborted`));
      });
    });
    req.on('error', (err) => finish(reject, err));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(reject, new Error(`GET ${url} timeout`));
    });
  });
}

function callCron(baseUrl, job, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}/api/cron/${job}`,
      {
        // 桌面端 cronAuth 要求本机 Origin:无 Origin 的子资源请求(恶意网页的
        // <img>/<link>/表单)一律 403,调度器自身必须显式带 Origin 才能通过。
        headers: { Origin: baseUrl },
      },
      (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(true);
        resolve(false);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`cron ${job} timeout`)); });
  });
}

/** Turso 模式下设置存在远端库，本地 app_settings 读不到，改问内置 server。 */
async function fetchLlmConfigured(baseUrl) {
  const data = await getJson(`${baseUrl}/api/desktop/runtime`, { timeoutMs: 3000 });
  return Boolean(data && data.llmConfigured);
}

/** 创建调度器:start() 延迟一轮后开始,之后每 intervalMs 一轮。 */
function createScheduler({
  baseUrl, dbPath, configFile, onRunStart, onRunEnd,
  getConfig = loadConfig, getSettings = getAppSettings,
  isDbAvailable, getLlmConfigured,
  firstRunDelayMs = FIRST_RUN_DELAY_MS, minIntervalMs = MIN_INTERVAL_MS,
}) {
  const cfg = getConfig(configFile, { intervalMs: DEFAULT_INTERVAL_MS, notifyLastRunAt: null });
  const interval = normalizeIntervalMs(cfg.intervalMs, minIntervalMs);
  let timer = null;
  let firstRunTimer = null;
  let running = false;
  let stopped = false;

  async function runOnce() {
    if (running) return 'running'; // 上一轮仍在跑:跳过并如实上报(不再静默当成功)
    if (stopped) return 'stopped';
    // 全新安装、用户尚未选择导入/全新开始:不发起任何请求,防止 /api/cron/*
    // 经 getDb() 抢先建库(欢迎页门控依赖文件不存在)。远端库由 main 注入
    // isDbAvailable,不依赖本地文件。
    const dbReady = isDbAvailable
      ? isDbAvailable()
      : Boolean(dbPath && fs.existsSync(dbPath));
    if (!dbReady) {
      console.log('[scheduler] db 不存在,跳过本轮');
      return 'no-db';
    }
    running = true;
    try {
      let llmConfigured;
      if (getLlmConfigured) {
        // 远端库读不到本地 app_settings;探测失败时只降级为 fetch,不中断整轮
        try {
          llmConfigured = await getLlmConfigured();
        } catch (err) {
          console.error('[scheduler] llm status failed:', err.message);
          llmConfigured = false;
        }
      } else {
        llmConfigured = isLlmConfigured(await getSettings(dbPath));
      }
      // 收盘链路不依赖 LLM（无 key 时只发确定性简报），且路由自己按交易日/报告节流，
      // 因此每轮都带一个轻量请求，不会因调度频率重复拉行情。
      const sequence = [...buildJobSequence({ llmConfigured }), COCKPIT_DAILY_JOB];
      if (onRunStart) onRunStart(sequence);
      for (const job of sequence) {
        if (stopped) break; // stop()(重启/退出)后不再发新请求
        try {
          const ok = await callCron(baseUrl, job);
          if (!ok) console.log(`[scheduler] ${job} skipped/failed`);
        } catch (err) {
          // 单个 job 失败(超时等)不中断本轮:后续 job 照常,onRunEnd 照常
          console.error(`[scheduler] ${job} failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('[scheduler] run failed:', err.message);
    } finally {
      running = false;
      // 无论成败都推进通知游标:通知查询按 analyzed_at 增量,失败轮没有新行,
      // 游标不动 → 不会漏报也不会重复(旧实现失败时跳过 onRunEnd 会丢通知+重复)。
      if (onRunEnd) onRunEnd();
    }
  }

  function start() {
    // 幂等:重复 start(未 stop)先清掉旧定时器,避免双 interval 双发
    if (timer) clearInterval(timer);
    if (firstRunTimer) clearTimeout(firstRunTimer);
    stopped = false;
    timer = setInterval(() => { runOnce().catch(() => {}); }, interval);
    timer.unref();
    firstRunTimer = setTimeout(() => {
      firstRunTimer = null;
      runOnce().catch(() => {});
    }, firstRunDelayMs);
    if (firstRunTimer && typeof firstRunTimer.unref === 'function') firstRunTimer.unref();
  }

  function stop() {
    stopped = true; // 在途 runOnce 在 job 边界退出,不再发新请求
    if (timer) clearInterval(timer);
    timer = null;
    if (firstRunTimer) clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }

  return { start, stop, runOnce };
}

module.exports = {
  createScheduler,
  callCron,
  fetchLlmConfigured,
  normalizeIntervalMs,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
};
