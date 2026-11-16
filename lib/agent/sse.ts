/** 研究 Agent SSE 解析与错误分类。 */

export type AgentStreamErrorKind = 'network' | 'stream' | 'interrupted' | 'protocol';

export const AGENT_STREAM_ERROR_COPY: Record<
  AgentStreamErrorKind,
  { title: string; description: string }
> = {
  network: { title: '网络连接失败', description: '无法连接研究助手，请检查网络后重试。' },
  stream: { title: '服务端返回错误', description: '研究助手暂时不可用，请稍后重试。' },
  interrupted: { title: '回答未完成', description: '连接提前结束，可以重试本次提问。' },
  protocol: { title: '响应格式异常', description: '服务端返回了无法识别的数据，请重试。' },
};

export class AgentStreamError extends Error {
  readonly kind: AgentStreamErrorKind;
  /** 服务端可展示的具体原因 */
  readonly detail?: string;

  constructor(kind: AgentStreamErrorKind, detail?: string) {
    super(detail || AGENT_STREAM_ERROR_COPY[kind].description);
    this.name = 'AgentStreamError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** 非协议类异常（fetch/reader 抛出）统一归为网络错误。 */
export function toAgentStreamError(err: unknown): AgentStreamError {
  return err instanceof AgentStreamError ? err : new AgentStreamError('network');
}

export interface AgentSseEvent {
  event: string;
  data: string;
}

/**
 * 规范 SSE 解码：兼容 CRLF/LF/CR、多行 data、注释行与任意分块边界。
 * 一个事件以空行结束，未结束的半截事件在流关闭时丢弃。
 */
export class AgentSseDecoder {
  private buffer = '';
  private dataLines: string[] = [];
  private eventType = '';
  private hasData = false;

  push(chunk: string): AgentSseEvent[] {
    this.buffer += chunk;
    const out: AgentSseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // 末尾单独的 CR 可能是跨块的 CRLF 前半，等下一块
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.processLine(line);
      if (event) out.push(event);
    }
    return out;
  }

  private processLine(line: string): AgentSseEvent | null {
    if (line === '') {
      if (!this.hasData) {
        this.eventType = '';
        return null;
      }
      const event = {
        event: this.eventType || 'message',
        data: this.dataLines.join('\n'),
      };
      this.dataLines = [];
      this.hasData = false;
      this.eventType = '';
      return event;
    }
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') this.eventType = value;
    else if (field === 'data') {
      this.dataLines.push(value);
      this.hasData = true;
    }
    return null;
  }
}

/**
 * 消费 Agent SSE 流并派发事件；缺少 done 视为中断，error 事件与坏 JSON 抛出分类错误。
 */
export async function consumeAgentEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: string, payload: any) => void,
): Promise<void> {
  const reader = stream.getReader();
  const textDecoder = new TextDecoder();
  const decoder = new AgentSseDecoder();
  let sawDone = false;

  const handle = (ev: AgentSseEvent) => {
    if (!ev.event) return;
    let payload: any;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      throw new AgentStreamError('protocol');
    }
    if (ev.event === 'error') {
      throw new AgentStreamError(
        'stream',
        typeof payload?.error === 'string' && payload.error ? payload.error : undefined,
      );
    }
    if (ev.event === 'done') sawDone = true;
    onEvent(ev.event, payload);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = textDecoder.decode(value, { stream: true });
      for (const ev of decoder.push(chunk)) handle(ev);
    }
    const tail = textDecoder.decode();
    for (const ev of decoder.push(tail)) handle(ev);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (!sawDone) throw new AgentStreamError('interrupted');
}
