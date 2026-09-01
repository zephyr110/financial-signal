'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('./libsql-client');

const REQUIRED_TABLES = ['news_archive', 'app_settings'];
// 结构校验:不仅要有表,关键列也必须齐全——否则旧结构库导入"成功"后
// 管线查询直接 no such column,比拒绝导入更糟(用户以为数据已就位)。
const REQUIRED_COLUMNS = {
  news_archive: ['id', 'source', 'source_id', 'content', 'published_at'],
  app_settings: ['key', 'value'],
};

/** 校验 db 文件:可打开、含必要表且关键列齐全。返回 { ok, error? } */
async function validateDbFile(file) {
  try {
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    // 只读打开:普通打开会把用户的源文件当可写库——WAL 模式会留下 -wal/-shm
    // 侧车文件、close 时还可能 checkpoint 写回用户的原始文件。
    // mode=ro 是 SQLite URI 参数,libsql 嵌入式后端支持;个别旧版不支持时
    // 回退普通打开(校验仍是只读查询,不会写数据)。
    let client;
    try {
      client = createClient({ url: `file:${file}?mode=ro` });
    } catch {
      client = createClient({ url: `file:${file}` });
    }
    try {
      for (const table of REQUIRED_TABLES) {
        const r = await client.execute({
          sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          args: [table],
        });
        if (r.rows.length === 0) {
          return { ok: false, error: `缺少必要表: ${table}` };
        }
        const cols = await client.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
        const names = new Set(cols.rows.map((c) => c.name));
        for (const col of REQUIRED_COLUMNS[table] || []) {
          if (!names.has(col)) {
            return { ok: false, error: `表 ${table} 缺少必要列: ${col}` };
          }
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

/**
 * WAL 已提交但尚未 checkpoint 进主文件的变更,只复制 .db 会静默丢失。
 * 复制前对源库做一次 wal_checkpoint(TRUNCATE) 把 -wal 内容落进主文件;
 * 源库正被其他进程写入时 checkpoint 可能 busy,按 best-effort 处理(此时
 * 复制本身就存在竞态,尽力而为)。打开产生的空 -wal/-shm 侧车文件在关闭后
 * 清理(仅当源库原本没有这些文件,避免删掉对方活跃的 WAL)。
 */
async function checkpointSource(src) {
  const walPath = `${src}-wal`;
  const shmPath = `${src}-shm`;
  const hadWal = fs.existsSync(walPath);
  const hadShm = fs.existsSync(shmPath);
  try {
    const client = createClient({ url: `file:${src}` });
    try {
      await client.execute({ sql: 'PRAGMA wal_checkpoint(TRUNCATE)', args: [] });
    } finally {
      await client.close();
    }
  } catch (err) {
    console.warn(`[import-db] wal_checkpoint skipped for ${src}: ${err.message}`);
  }
  // 清理我们打开 WAL 库时产生的空侧车文件(源库原本不存在时才删)
  if (!hadWal && fs.existsSync(walPath)) {
    try { fs.unlinkSync(walPath); } catch { /* 忽略 */ }
  }
  if (!hadShm && fs.existsSync(shmPath)) {
    try { fs.unlinkSync(shmPath); } catch { /* 忽略 */ }
  }
}

/** 校验通过后原子替换到目标路径。返回 { ok, error? } */
async function importDbFile(src, dest) {
  const v = await validateDbFile(src);
  if (!v.ok) return v;
  await checkpointSource(src);
  // 先拷临时文件再 rename:rename 换 inode,旧文件全程完整,
  // 活跃 server 连接(可能正在写库)不受影响,重启后自然打开新 inode。
  const tmp = `${dest}.tmp`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, tmp);
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      // Windows:SQLite 打开的文件不带 FILE_SHARE_DELETE,rename 必然 EPERM;
      // 服务器持有的旧句柄允许写共享 → 覆盖复制可行(非原子,重启后生效,
      // 可接受)。其他平台/错误码则照常抛出。
      if (process.platform !== 'win32' && err.code !== 'EPERM' && err.code !== 'EBUSY') {
        throw err;
      }
      fs.copyFileSync(tmp, dest);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 清理失败忽略(目标已是新内容,残留 tmp 无害)
      }
    }
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
