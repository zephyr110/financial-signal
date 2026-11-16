import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentProcessingBlock } from "../../components/AgentProcessingBlock";
import type { ProcessingBlock } from "../../types/agent-chat";

const thinkingOnly: ProcessingBlock = { tools: [], active: true, thinking: true };

describe("AgentProcessingBlock", () => {
  it("进行中的思考默认折叠，只显示摘要行", () => {
    render(<AgentProcessingBlock processing={thinkingOnly} />);
    expect(screen.getByText("思考中")).toBeInTheDocument();
    expect(screen.queryByText("正在分析并规划下一步")).not.toBeInTheDocument();
  });

  it("历史（已完成）轮次默认折叠", () => {
    render(
      <AgentProcessingBlock
        processing={{
          tools: [
            { name: "search_news", args: { q: "半导体" }, status: "done", summary: "3 条结果" },
          ],
          active: false,
          thinking: false,
        }}
      />
    );
    expect(screen.getByText("已调用 1 个工具")).toBeInTheDocument();
    expect(screen.queryByText("3 条结果")).not.toBeInTheDocument();
  });

  it("点击摘要行可手动展开查看详情", () => {
    render(<AgentProcessingBlock processing={thinkingOnly} />);
    fireEvent.click(screen.getByText("思考中"));
    expect(screen.getByText("正在分析并规划下一步")).toBeInTheDocument();
  });

  it("用户展开后不因轮次结束而自动折叠", () => {
    const { rerender } = render(<AgentProcessingBlock processing={thinkingOnly} />);
    fireEvent.click(screen.getByText("思考中"));
    expect(screen.getByText("正在分析并规划下一步")).toBeInTheDocument();

    rerender(
      <AgentProcessingBlock processing={{ tools: [], active: false, thinking: true }} />
    );
    expect(screen.getByText("正在分析并规划下一步")).toBeInTheDocument();
  });
});
