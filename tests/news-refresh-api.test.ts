import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/archive', () => ({ archiveNews: vi.fn() }));
vi.mock('../lib/analyze', () => ({ analyzeUnanalyzedNews: vi.fn() }));
vi.mock('../lib/pipeline', () => ({
  withPipelineRun: async (_job: string, _batch: string, fn: () => Promise<any>) => fn(),
}));

import { archiveNews } from '../lib/archive';
import { analyzeUnanalyzedNews } from '../lib/analyze';
import handler from '../pages/api/news/refresh';

const archiveMock = vi.mocked(archiveNews);
const analyzeMock = vi.mocked(analyzeUnanalyzedNews);

function mockRes() {
  const res: any = { statusCode: 0, body: null, headers: {} as Record<string, string> };
  res.setHeader = (key: string, value: string) => {
    res.headers[key] = value;
    return res;
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

describe('POST /api/news/refresh', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('抓取后分析最新一批并返回数量', async () => {
    archiveMock.mockResolvedValue({
      duplicates: 2,
      sina: 3,
      '10jqka': 0,
      eastmoney: 0,
      cls: 0,
      wallstreetcn: 0,
    } as any);
    analyzeMock.mockResolvedValue({ analyzed: 10, errors: 0, hasMore: true });

    const res = mockRes();
    await handler({ method: 'POST' }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      fetched: 3,
      duplicates: 2,
      analyzed: 10,
      errors: 0,
      hasMore: true,
    });
    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(analyzeMock).toHaveBeenCalledWith(5, 2);
  });

  it('非 POST 不触发管线', async () => {
    const res = mockRes();
    await handler({ method: 'GET' }, res);

    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expect(archiveMock).not.toHaveBeenCalled();
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('抓取失败返回 500 且不分析', async () => {
    archiveMock.mockRejectedValue(new Error('source down'));

    const res = mockRes();
    await handler({ method: 'POST' }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toContain('失败');
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('分析失败返回 500', async () => {
    archiveMock.mockResolvedValue({ duplicates: 0, sina: 1 } as any);
    analyzeMock.mockRejectedValue(new Error('llm down'));

    const res = mockRes();
    await handler({ method: 'POST' }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toContain('失败');
  });
});
