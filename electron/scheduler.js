'use strict';
const http = require('http');
const { buildJobSequence, isLlmConfigured } = require('./scheduler-core');
const { loadConfig } = require('./store');
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

/** 创建调度器:start() 立即执行一轮管线,之后每 intervalMs 一轮。 */
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

  function start() {
    timer = setInterval(() => { runOnce().catch(() => {}); }, cfg.intervalMs);
    timer.unref();
    return runOnce().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce };
}

module.exports = { createScheduler, callCron, DEFAULT_INTERVAL_MS };
