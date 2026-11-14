/**
 * 会话级互斥：同一会话同一时刻只允许一轮生成。
 * 进程内锁即可——桌面/单实例部署只有一个 Next server；多实例时需换成 DB 租约。
 */

const active = new Map<number, Promise<void>>();

export class AgentSessionBusyError extends Error {
  readonly code = 'SESSION_BUSY';
  constructor(readonly sessionId: number) {
    super('该会话正在生成回复，请等待本轮完成或换一个会话');
    this.name = 'AgentSessionBusyError';
  }
}

/** 获取会话锁；已被占用时立即抛 AgentSessionBusyError，不排队。 */
export async function acquireAgentSessionLock(sessionId: number): Promise<() => void> {
  if (active.has(sessionId)) throw new AgentSessionBusyError(sessionId);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  active.set(sessionId, held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.delete(sessionId);
    release();
  };
}
