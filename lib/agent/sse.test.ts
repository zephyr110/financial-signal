import { describe, it, expect } from 'vitest';
import {
  AgentSseDecoder,
  AgentStreamError,
  consumeAgentEventStream,
  toAgentStreamError,
} from './sse';

const enc = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe('AgentSseDecoder', () => {
  it('解析 event/data 并以空行派发多行 data', () => {
    const d = new AgentSseDecoder();
    const events = d.push('event: token\ndata: {"a":\ndata: 1}\n\n');
    expect(events).toEqual([{ event: 'token', data: '{"a":\n1}' }]);
  });

  it('兼容 CRLF、CR 与跨块边界', () => {
    const d = new AgentSseDecoder();
    // CRLF 与单独的 CR 行尾、事件被任意切开
    expect(d.push('event: x\r\ndata: 1\r')).toEqual([]);
    expect(d.push('\ndata: 2\r\r\n')).toEqual([{ event: 'x', data: '1\n2' }]);
  });

  it('忽略注释行与无 data 的空事件', () => {
    const d = new AgentSseDecoder();
    const events = d.push(': keep-alive\n\nevent: ping\n\ndata: ok\n\n');
    expect(events).toEqual([{ event: 'message', data: 'ok' }]);
  });

  it('流结束丢弃未以空行结束的半截事件', () => {
    const d = new AgentSseDecoder();
    expect(d.push('data: half')).toEqual([]);
  });
});

describe('consumeAgentEventStream', () => {
  it('正常流:按序回调并在 done 后正常返回', async () => {
    const seen: string[] = [];
    await consumeAgentEventStream(
      streamOf(['data: {"t":"a"}\n\n', 'event: done\ndata: {"id":1}\n\n']),
      (event) => seen.push(event),
    );
    expect(seen).toEqual(['message', 'done']);
  });

  it('error 事件 → stream 错误,携带服务端原因', async () => {
    const err = await consumeAgentEventStream(
      streamOf(['event: error\ndata: {"error":"模型不可用"}\n\n']),
      () => {},
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AgentStreamError);
    expect(err.kind).toBe('stream');
    expect(err.detail).toBe('模型不可用');
  });

  it('坏 JSON → protocol 错误', async () => {
    const err = await consumeAgentEventStream(streamOf(['data: not-json\n\n']), () => {}).catch((e) => e);
    expect(err.kind).toBe('protocol');
  });

  it('没有 done 就结束 → interrupted', async () => {
    const err = await consumeAgentEventStream(streamOf(['data: {"t":"a"}\n\n']), () => {}).catch(
      (e) => e,
    );
    expect(err.kind).toBe('interrupted');
  });

  it('读取中断 → 归为 network 错误', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"t":"a"}\n\n'));
        controller.error(new Error('socket hang up'));
      },
    });
    const err = await consumeAgentEventStream(stream, () => {}).catch((e) => e);
    expect(err.message).toBe('socket hang up');
    expect(toAgentStreamError(err).kind).toBe('network');
  });
});

describe('toAgentStreamError', () => {
  it('保留已分类错误,其余归为 network', () => {
    const protocol = new AgentStreamError('protocol');
    expect(toAgentStreamError(protocol)).toBe(protocol);
    expect(toAgentStreamError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(toAgentStreamError('boom').kind).toBe('network');
  });
});
