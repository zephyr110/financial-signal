import { isValidElement, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AgentCodeBlock from "./agent-code-block";
import { useThrottledMarkdown } from "@/hooks/use-throttled-markdown";
import { stripToolProtocolFromAnswer } from "@/lib/agent/format";
import { sanitizeAnswerText } from "@/lib/safe-json";

// 引用保持稳定，避免父组件每次渲染（如输入框击键）都重建 Markdown 解析树
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = {
  // 链接新开页，避免打断对话
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  pre: ({ node: _node, children }) => {
    const codeEl = isValidElement(children) ? children : null;
    const cls = (codeEl?.props as { className?: string } | undefined)?.className ?? "";
    const lang = (cls.match(/language-([\w-]+)/) || [])[1] || "";
    return (
      <AgentCodeBlock lang={lang}>
        {(codeEl?.props as { children?: unknown } | undefined)?.children ?? children}
      </AgentCodeBlock>
    );
  },
};

/** 助手 Markdown 正文；流式生成时按渲染耗时节流，完成后立即显示全文 */
export function AgentMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  // 历史消息可能早于服务端清洗上线，渲染端两层兜底：先剥协议标记，再清内部编号。
  // 清洗是十几条正则，父组件每敲一个字都跑一遍太浪费；只在正文变化时重算。
  const cleaned = useMemo(
    () => sanitizeAnswerText(stripToolProtocolFromAnswer(content)),
    [content],
  );
  const rendered = useThrottledMarkdown(cleaned, streaming);
  return (
    <div className="markdown-body text-sm leading-7 text-foreground">
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {rendered}
      </ReactMarkdown>
    </div>
  );
}
