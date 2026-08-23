// 打包后把 standalone 的 node_modules 补齐到 Resources/standalone。
//
// 为什么需要这个 hook:electron-builder 的 createFilter(app-builder-lib/out/util/filter.js)
// 对根 node_modules 目录有硬编码拒绝(relative === "node_modules" → false),
// 任何 extraResources 的 filter 都无法放行;所以 extraResources 复制 standalone 时会
// 缺 node_modules。hook 在 pack 之后执行,与 extraResources 写的是不相交的路径,顺序无关。
//
// 为什么手写递归复制:pnpm 布局用相对 symlink(293 个,如 @libsql/client ⇒ ../.pnpm/...)。
// Node fs.cp 会把相对 symlink 改写为源机器的绝对路径(仅本机可用,分发即坏);
// dereference:true 又会因 pruned store 的 dangling link 报错。手写复制按 readlink 原样
// 重建 symlink,相对目标在复制后的树内仍有效;dangling link(.pnpm/node_modules/semver,
// 运行时无人解析)照原样保留,无害。
import { existsSync } from 'fs';
import { copyFile, lstat, mkdir, readdir, readlink, realpath, symlink } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Windows 上的链接处理(process.platform === 'win32'):
// pnpm 对 node_modules 的目录链接用的是 junction,而 junction 存的是【绝对路径】
// (指向 CI workspace 内的 .next/standalone/node_modules/.pnpm/...)。打包后整棵树
// 被搬到用户的 Resources/standalone,绝对路径必然失效——重建 junction 等于生成
// 一串坏链接;普通 Windows symlink 创建则需要 Developer Mode/管理员权限,
// CI runner 上会直接 EPERM。所以 Windows 上唯一正确且无特权的做法是【物化复制】:
// 按 realpath 解析链接链后把目标内容整体复制到 dest(等价 dereference)。
// 代价是 .pnpm 中被多份引用的包会重复落盘,但功能等价、无需任何特权。
// 目标不存在(dangling link,运行时无人解析,见上方文件头注释)时建空目录兜底,
// 不让个别 dangling 链接拖垮整个打包。mac/Linux 不经过此分支,保持原样。
async function copyTree(src, dest) {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    const target = await readlink(src);
    if (process.platform === 'win32') {
      const absTarget = path.resolve(path.dirname(src), target);
      let resolved = null;
      try {
        resolved = await realpath(absTarget); // 解析链接链(含 junction)
      } catch {
        /* dangling link:目标不存在 */
      }
      if (resolved) {
        const resolvedSt = await lstat(resolved);
        if (resolvedSt.isDirectory()) return copyTree(resolved, dest);
        if (resolvedSt.isFile()) return copyFile(resolved, dest);
      }
      await mkdir(dest, { recursive: true }); // dangling 或未知类型:空目录兜底
      return;
    }
    // mac/Linux:pnpm 相对 symlink(如 ../.pnpm/...),readlink 原样重建,
    // 相对目标在复制后的树内仍有效,搬移不影响。
    await symlink(target, dest);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    await Promise.all(entries.map((e) => copyTree(path.join(src, e.name), path.join(dest, e.name))));
    return;
  }
  await copyFile(src, dest);
}

export async function afterPack(context) {
  const { appOutDir, packager } = context;
  // mac:appOutDir 是父目录(如 dist/mac),.app bundle 在其下;win/linux:appOutDir 即 app 目录。
  const appBundle = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const resourcesDir = existsSync(path.join(appBundle, 'Contents'))
    ? path.join(appBundle, 'Contents', 'Resources')
    : appOutDir;
  const src = path.join(ROOT, '.next', 'standalone', 'node_modules');
  await lstat(src).catch((err) => {
    if (err.code === 'ENOENT') console.warn('[after-pack] standalone node_modules 不存在,跳过:', src);
    throw err;
  });
  const dest = path.join(resourcesDir, 'standalone', 'node_modules');
  await copyTree(src, dest);
  console.log('[after-pack] standalone node_modules →', dest);
}
