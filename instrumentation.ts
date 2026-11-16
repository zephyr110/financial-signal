/**
 * Next 服务启动钩子：只在 Node 运行时启动交易时段调度器。
 * 测试/构建/Vercel/演示模式与 COCKPIT_LIVE_SCHEDULER=0 时自动跳过。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startLiveScheduler } = await import('./lib/cockpit/live-scheduler')
  startLiveScheduler()
}
