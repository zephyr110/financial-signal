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
