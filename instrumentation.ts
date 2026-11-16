/**
 * Next 服务启动钩子：只在 Node 运行时启动交易时段调度器。
 * 测试/构建/Vercel/演示模式与 COCKPIT_LIVE_SCHEDULER=0 时自动跳过。
 */
export async function register(): Promise<void> {
  // 必须写成正向条件块：dev 非压缩构建不会消除「提前 return」之后的分支，
  // 调度器及其 crypto 依赖会被 Edge 编译一起打包并报错。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startLiveScheduler } = await import('./lib/cockpit/live-scheduler')
    startLiveScheduler()
  }
}
