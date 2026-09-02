import { describe, it, expect } from "vitest";
import { historyToChatItems } from "./agent-chat";

describe("historyToChatItems", () => {
  it("将连续工具调用合并到紧随其后的助手正文", () => {
    const items = historyToChatItems([
      { id: 1, role: "user", content: "你好" },
      {
        id: 2,
        role: "assistant",
        content: '{"tool":"search_news","args":{"query":"半导体"}}',
        meta: { toolCall: { name: "search_news", args: { query: "半导体" } } },
      },
      {
        id: 3,
        role: "user",
        content: "【工具 search_news 结果】\n找到 3 条",
        meta: { toolResult: { name: "search_news", ok: true, content: "找到 3 条" } },
      },
      { id: 4, role: "assistant", content: "半导体近期信号较强。" },
    ]);

    expect(items).toHaveLength(2);
    expect(items[1].processing?.tools).toHaveLength(1);
    expect(items[1].processing?.tools[0].name).toBe("search_news");
    expect(items[1].processing?.tools[0].summary).toBe("找到 3 条");
    expect(items[1].content).toBe("半导体近期信号较强。");
  });

  it("无后续正文时单独输出 processing 块", () => {
    const items = historyToChatItems([
      {
        id: 1,
        role: "assistant",
        content: '{"tool":"search_news","args":{}}',
        meta: { toolCall: { name: "search_news", args: {} } },
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].processing?.tools).toHaveLength(1);
    expect(items[0].content).toBe("");
  });

  it("上下文压缩摘要并入下一条助手回复的 processing", () => {
    const items = historyToChatItems([
      {
        id: 1,
        role: "system",
        content: "（历史对话已压缩）用户关注半导体行业。",
        meta: { contextCompact: true, summarizedCount: 6 },
      },
      { id: 2, role: "user", content: "继续分析" },
      { id: 3, role: "assistant", content: "半导体近期信号较强。" },
    ]);

    expect(items).toHaveLength(2);
    expect(items[1].processing?.compaction).toMatchObject({
      status: "done",
      summarizedCount: 6,
      summary: "用户关注半导体行业。",
    });
    expect(items[1].content).toBe("半导体近期信号较强。");
  });
});
