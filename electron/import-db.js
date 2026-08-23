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

/** 校验通过后原子替换到目标路径。返回 { ok, error? } */
async function importDbFile(src, dest) {
  const v = await validateDbFile(src);
  if (!v.ok) return v;
  // 先拷临时文件再 rename:rename 换 inode,旧文件全程完整,
  // 活跃 server 连接(可能正在写库)不受影响,重启后自然打开新 inode。
  const tmp = `${dest}.tmp`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
    return { ok: true };
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // 清理失败只记日志,不掩盖原始错误
    }
    return { ok: false, error: `复制失败: ${err.message}` };
  }
}

module.exports = { validateDbFile, importDbFile };
