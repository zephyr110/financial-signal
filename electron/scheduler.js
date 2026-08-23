'use strict';
const http = require('http');
const fs = require('fs');
const { buildJobSequence, isLlmConfigured } = require('./scheduler-core');
const { loadConfig } = require('./store');
const { getSettings: getAppSettings } = require('./app-settings');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// 防御下限:config.json 被手动写坏(0/负数)时避免 setInterval 空转烧 LLM 额度
const MIN_INTERVAL_MS = 60 * 1000;
// 启动后延迟首轮:崩溃重启/换库后立刻全量跑会与旧实例在途轮次重叠,
// 对同一批未分析新闻重复发起 LLM 调用。托盘"立即抓取"不受此延迟影响。
const FIRST_RUN_DELAY_MS = 15 * 1000;

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

/** 创建调度器:start() 延迟一轮后开始,之后每 intervalMs 一轮。 */
function createScheduler({
  baseUrl, dbPath, configFile, onRunStart, onRunEnd,
  getConfig = loadConfig, getSettings = getAppSettings,
  firstRunDelayMs = FIRST_RUN_DELAY_MS, minIntervalMs = MIN_INTERVAL_MS,
}) {
  const cfg = getConfig(configFile, { intervalMs: DEFAULT_INTERVAL_MS, notifyLastRunAt: null });
  const interval = Math.max(minIntervalMs, cfg.intervalMs);
  let timer = null;
  let firstRunTimer = null;
  let running = false;
  let stopped = false;

  async function runOnce() {
    if (running) return 'running'; // 上一轮仍在跑:跳过并如实上报(不再静默当成功)
    if (stopped) return 'stopped';
    // 全新安装、用户尚未选择导入/全新开始:不发起任何请求,防止 /api/cron/*
    // 经 getDb() 抢先建库(欢迎页门控依赖文件不存在)。
    if (!dbPath || !fs.existsSync(dbPath)) {
      console.log('[scheduler] db 不存在,跳过本轮');
      return 'no-db';
    }
    running = true;
    try {
      const settings = await getSettings(dbPath);
      const sequence = buildJobSequence({ llmConfigured: isLlmConfigured(settings) });
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

module.exports = { createScheduler, callCron, DEFAULT_INTERVAL_MS };
