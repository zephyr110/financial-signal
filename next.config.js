/** @type {import('next').NextConfig} */
const nextConfig = {
  // ISR 配合 Vercel 自动处理，无需额外配置
  // workspace root：显式指向项目根，避免误检 /Users/zephyr/pnpm-workspace.yaml（多个 workspace 文件时 Next 推断错误）
  turbopack: {
    root: __dirname,
  },
  // 桌面端:产出自包含服务器(electron 主进程拉起 .next/standalone/server.js)
  output: 'standalone',
  // dev 模式:Electron 窗口从 http://127.0.0.1:3010 加载,放行 HMR/字体等 dev 资源
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  // 构建期不跑 eslint:接入 eslint 后 next build 会开始检查并可能因历史存量问题
  // 阻塞部署;lint 由独立 `pnpm lint`(警告渐进清零)把关,部署稳定性优先
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
