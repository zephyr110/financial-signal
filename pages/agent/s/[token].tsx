import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Head from "next/head";
import Link from "next/link";
import { Bot } from "lucide-react";
import AppShell from "../../../components/app-shell";
import { getSharedSession } from "../../../lib/db";

/**
 * 会话分享公开页（只读）：通过分享链接访问，无输入框、无编辑。
 * 渲染过滤：跳过工具调用 JSON（assistant 带 meta.toolCall）与
 * 工具结果回喂消息（user 以【工具开头），只保留真实对话内容。
 */
export default function SharedAgentPage({ title, messages, notFound }: any) {
  const items = (messages || []).filter(
    (r: any) =>
      !(r.role === "user" && String(r.content || "").startsWith("【工具")) &&
      !(r.role === "assistant" && r.meta?.toolCall)
  );

  return (
    <>
      <Head>
        <title>{notFound ? "分享链接无效 · 财经信号" : `${title || "会话分享"} · 财经信号`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
      </Head>

      <AppShell title="会话分享" subtitle={notFound ? undefined : title}>
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 sm:px-6 pb-12 pt-8">
          {notFound ? (
            <div className="text-center py-20">
              <p className="text-sm text-muted-foreground">分享链接无效或会话已被删除</p>
              <Link
                href="/agent"
                className="mt-4 inline-block text-sm text-primary hover:underline"
              >
                前往研究助手
              </Link>
            </div>
          ) : (
            <div className="space-y-5">
              {items.length === 0 && (
                <p className="text-center py-10 text-xs text-muted-foreground">该会话暂无内容</p>
              )}
              {items.map((r: any, i: number) =>
                r.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap">
                      {r.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex gap-2.5">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent">
                      <Bot className="size-4 text-muted-foreground" />
                    </div>
                    <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-card border px-4 py-2.5">
                      <div className="markdown-body text-sm">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ node: _node, ...props }) => (
                              <a {...props} target="_blank" rel="noopener noreferrer" />
                            ),
                          }}
                        >
                          {String(r.content || "")}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )
              )}
              <p className="text-center text-[11px] text-muted-foreground pt-4">
                由财经信号 · 研究助手生成 · 信息仅供研究参考
              </p>
            </div>
          )}
        </div>
      </AppShell>
    </>
  );
}

export async function getServerSideProps(context: any) {
  const token = String(context.params?.token || "");
  if (!token) return { props: { notFound: true, title: null, messages: [] } };
  try {
    const data = await getSharedSession(token);
    if (!data) return { props: { notFound: true, title: null, messages: [] } };
    return { props: { notFound: false, title: data.title, messages: data.messages } };
  } catch (e) {
    console.error("[agent/s] Error:", e);
    return { props: { notFound: true, title: null, messages: [] } };
  }
}
