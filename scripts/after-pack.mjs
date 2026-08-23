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
import { copyFile, lstat, mkdir, readdir, readlink, symlink } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function copyTree(src, dest) {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    const target = await readlink(src);
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
