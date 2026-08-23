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
import { existsSync, readdirSync } from 'fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readlink, realpath, symlink } from 'fs/promises';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
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
      } catch (err) {
        // 仅 dangling link(ENOENT/ELOOP)降级为空目录兜底,其余错误抛出,
        // 让真实问题(权限、路径非法等)暴露为打包失败而不是静默吞掉。
        if (err.code !== 'ENOENT' && err.code !== 'ELOOP') throw err;
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

/**
 * mac 双架构构建补全 @libsql 原生绑定。
 *
 * 背景:libsql@0.5.x 的 index.js 用模板字符串 require(`@libsql/${target}`)(无回退),
 * pnpm install 只装【宿主架构】的绑定;next build 的 standalone 里也只有这一份。
 * CI(macos-latest = arm64 runner)一次 install + 一次 build 产出 x64+arm64 两个
 * 产物,arm64 runner 上装的 @libsql/darwin-arm64 会被照抄进 x64 产物 → Intel Mac
 * 上 child server require('@libsql/darwin-x64') → MODULE_NOT_FOUND → 崩溃重启
 * 5 次 → onGiveUp 静默退出。
 *
 * 这里按 electron-builder 目标架构从 registry 拉取缺失绑定,并按 pnpm 布局落位:
 * 真实目录 .pnpm/@libsql+darwin-<arch>@<ver>/node_modules/@libsql/darwin-<arch>
 * + libsql 依赖目录下相对 symlink(require 从 libsql 的真实路径解析,只放顶层
 * node_modules 是找不到的)。仅 darwin 需要:win/linux 产物与 runner 同架构,自然命中。
 */
async function ensureLibsqlBindingForArch(dest, targetArch) {
  const target = String(targetArch);
  if (process.platform !== 'darwin') {
    if (target !== process.arch) {
      console.warn(`[after-pack] 非 darwin 跨架构产物(${process.arch}→${target})未补 @libsql 绑定`);
    }
    return;
  }
  if (target === process.arch) return; // 宿主架构:install 时已就位
  if (target === 'universal') {
    console.warn('[after-pack] universal 产物未补 @libsql 绑定(当前构建不使用 universal)');
    return;
  }
  const pnpmDir = path.join(dest, '.pnpm');
  if (!existsSync(pnpmDir)) return;
  const hostBinding = `darwin-${process.arch}`;
  const hostDir = readdirSync(pnpmDir).find((n) => n.startsWith(`@libsql+${hostBinding}@`));
  if (!hostDir) {
    console.warn('[after-pack] standalone 树中无 @libsql 绑定,跳过架构补全:', hostBinding);
    return;
  }
  const version = hostDir.slice(hostDir.lastIndexOf('@') + 1); // "@libsql+darwin-x64@0.5.29" → "0.5.29"
  const targetBinding = `darwin-${target}`;
  const targetDir = `@libsql+${targetBinding}@${version}`;
  if (existsSync(path.join(pnpmDir, targetDir))) return; // 已在树中(重复打包等)
  // 从 registry 拉取目标绑定(CI 有网络;失败必须中止——宁可构建失败,不产坏包)
  const tmp = await mkdtemp(path.join(tmpdir(), 'libsql-binding-'));
  try {
    execFileSync('npm', [
      'install', '--prefix', tmp, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
      `@libsql/${targetBinding}@${version}`,
    ], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`[after-pack] 拉取 @libsql/${targetBinding}@${version} 失败(${err.message}),中止 ${target} 产物构建`);
  }
  const srcPkg = path.join(tmp, 'node_modules', '@libsql', targetBinding);
  if (!existsSync(srcPkg)) {
    throw new Error(`[after-pack] @libsql/${targetBinding} 安装后缺失,中止构建`);
  }
  const realDir = path.join(pnpmDir, targetDir, 'node_modules', '@libsql', targetBinding);
  await mkdir(path.dirname(realDir), { recursive: true });
  await copyTree(srcPkg, realDir);
  // libsql 依赖目录下补 symlink:require(`@libsql/${target}`) 从 libsql 真实路径解析
  for (const dir of readdirSync(pnpmDir).filter((n) => /^libsql@/.test(n))) {
    const libsqlScope = path.join(pnpmDir, dir, 'node_modules', '@libsql');
    if (!existsSync(libsqlScope)) continue;
    const link = path.join(libsqlScope, targetBinding);
    if (!existsSync(link)) {
      await symlink(`../../../${targetDir}/node_modules/@libsql/${targetBinding}`, link);
    }
  }
  console.log(`[after-pack] 已为 ${target} 产物补全 @libsql/${targetBinding}@${version}`);
}

export async function afterPack(context) {
  const { appOutDir, packager, arch } = context;
  // mac:appOutDir 是父目录(如 dist/mac),.app bundle 在其下,extraResources 落在
  // <bundle>/Contents/Resources;
  // win/linux:appOutDir 即 app 目录,extraResources 落在 <appOutDir>/resources
  // (不是 appOutDir 本身!旧代码回退到 appOutDir 会把 node_modules 复制到
  // 错误位置,打包后的 Windows/Linux 应用缺 server 依赖 → MODULE_NOT_FOUND
  // → 崩溃重启 5 次 → onGiveUp 直接退出)。
  const appBundle = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const resourcesDir = existsSync(path.join(appBundle, 'Contents'))
    ? path.join(appBundle, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  const src = path.join(ROOT, '.next', 'standalone', 'node_modules');
  await lstat(src).catch((err) => {
    if (err.code === 'ENOENT') console.warn('[after-pack] standalone node_modules 不存在,跳过:', src);
    throw err;
  });
  const dest = path.join(resourcesDir, 'standalone', 'node_modules');
  await copyTree(src, dest);
  await ensureLibsqlBindingForArch(dest, arch);
  console.log('[after-pack] standalone node_modules →', dest);
}
