import { stripToolProtocolFromAnswer } from "@/lib/agent/format";

export interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  status?: "running" | "done" | "error";
  summary?: string;
}

export interface ProcessingBlock {
  tools: ToolCallInfo[];
  /** 本轮仍在进行（工具执行 / 等待模型） */
  active: boolean;
  /** 模型正在生成（工具 JSON 或下一步推理），尚未进入 tool_start */
  thinking: boolean;
}

export interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 单轮内的思考 + 工具调用过程（与正文同属一条助手消息） */
  processing?: ProcessingBlock;
  /** @deprecated 仅兼容旧数据，新逻辑统一走 processing */
  toolCall?: ToolCallInfo;
  toolLog?: { name: string; args: Record<string, unknown>; ok: boolean; summary: string }[];
}

/**
 * 服务端消息 → 前端 ChatItem：
 * - 连续 toolCall 合并为 processing，附着到紧随其后的助手正文（单条消息、单头像）
 * - user 内部工具结果 → 写入上一条工具的 summary
 */
export function historyToChatItems(rows: any[]): ChatItem[] {
  const out: ChatItem[] = [];
  let pendingTools: ToolCallInfo[] = [];

  const takeProcessing = (): ProcessingBlock | undefined => {
    if (pendingTools.length === 0) return undefined;
    const block: ProcessingBlock = {
      tools: pendingTools,
      active: false,
      thinking: false,
    };
    pendingTools = [];
    return block;
  };

  for (const r of rows) {
    if (r.role === "user" && r.content.startsWith("【工具")) {
      if (r.meta?.toolResult && pendingTools.length > 0) {
        const last = pendingTools[pendingTools.length - 1];
        last.summary = String(r.meta.toolResult.content || "").slice(0, 100);
        if (r.meta.toolResult.ok === false) last.status = "error";
      }
      continue;
    }

    if (r.role === "assistant" && r.meta?.toolCall) {
      pendingTools.push({
        ...r.meta.toolCall,
        status: r.meta.toolCall.status || "done",
      });
      continue;
    }

    const item: ChatItem = {
      id: `hist-${r.id}`,
      role: r.role,
      content: r.role === "assistant" ? stripToolProtocolFromAnswer(r.content) : r.content,
    };
    const processing = takeProcessing();
    if (processing) item.processing = processing;
    out.push(item);
  }

  const orphan = takeProcessing();
  if (orphan) {
    out.push({
      id: `hist-proc-${out.length}`,
      role: "assistant",
      content: "",
      processing: orphan,
    });
  }

  return out;
}
