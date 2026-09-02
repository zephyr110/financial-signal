import { useState, useEffect, useRef, useCallback, isValidElement } from "react";
import Head from "next/head";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquareText, Send, Loader2, Copy, Check, Share2, Pencil, X } from "lucide-react";
import AppShell from "../components/app-shell";
import SessionSidebarGroup from "../components/SessionSidebarGroup";
import AgentCodeBlock from "../components/agent-code-block";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentProcessingBlock } from "@/components/AgentProcessingBlock";
import { looksLikeJson, stripToolProtocolFromAnswer } from "@/lib/agent/format";
import { historyToChatItems, type ChatItem } from "@/types/agent-chat";
import { useAutosizeTextarea } from "@/hooks/use-autosize-textarea";

// ReactMarkdown v10：components/remarkPlugins 引用变化会触发全部 markdown 重新解析。
// 提升为模块级常量，避免父组件每次 render（如输入框击键）都重建引用导致重解析
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = {
  // 链接新开页，避免打断对话
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // 代码块：参考 zlog CodeBlock——顶栏（语言标签 + 复制）+ 圆角容器
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
import { Button } from "../components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "../components/ui/alert";
import { Textarea } from "../components/ui/textarea";
import { cn } from "@/lib/utils";

interface SessionSummary {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_STORAGE_KEY = "agent-session-id";

/** 触顶截断后一键续跑的用户消息 */
const CONTINUE_ANALYSIS_MESSAGE =
  "请基于上文已收集的信息继续深入分析，必要时可补充调用工具。";

// 空状态建议问题：点击直接发送
const SUGGESTIONS = [
  "存储涨价链条现在到哪个阶段了？",
  "今天有哪些政策信号？",
  "半导体行业近一周信号强度如何？",
];

export default function AgentPage() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 正在编辑的用户消息（仅 hist-* 有数据库 id，可编辑重发）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useAutosizeTextarea(inputRef, input, { maxHeight: 200 });

  // 复制回复文本；短时显示"已复制"反馈
  const copyMessage = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // 剪贴板不可用（非安全上下文等）时静默
    }
  }, []);

  // 分享会话：生成公开只读链接（Web Share API 优先，不支持时降级为复制链接）
  const shareConversation = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch("/api/agent-share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const url = `${window.location.origin}${data.path}`;
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share({ title: "财经信号会话分享", url });
          return;
        } catch {
          // 用户取消分享等，降级为复制链接
        }
      }
      await copyMessage("share", url);
    } catch {
      // 分享失败静默（无独立错误提示空间）
    }
  }, [sessionId, copyMessage]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const persistSession = useCallback((id: number | null) => {
    try {
      if (id == null) localStorage.removeItem(SESSION_STORAGE_KEY);
      else localStorage.setItem(SESSION_STORAGE_KEY, String(id));
    } catch {
      // 静默降级
    }
  }, []);

  // 会话列表（失败静默：侧栏留空即可，不影响主对话）
  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-sessions");
      if (!res.ok) return;
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      // 静默
    }
  }, []);

  // 加载某会话的全部消息（不切换会话 id 时用 restore）
  const loadSession = useCallback(
    async (id: number) => {
      setLoadingHistory(true);
      setError(null);
      // 切换会话时清空旧消息，避免与加载指示叠加显示
      setMessages([]);
      try {
        const res = await fetch(`/api/agent-sessions?id=${id}`);
        // 会话不存在（已被删除/数据库重建）：清掉残留缓存，回到新会话状态，避免
        // 后续发送带着失效 sessionId 触发服务端外键错误（500「研究助手暂时不可用」）
        if (res.status === 404) {
          setSessionId(null);
          persistSession(null);
          setMessages([]);
          setLoadingHistory(false);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setMessages(historyToChatItems(data.messages || []));
        setSessionId(id);
        persistSession(id);
      } catch {
        setError("历史会话加载失败，请稍后重试");
      } finally {
        setLoadingHistory(false);
      }
    },
    [persistSession]
  );

  // 刷新后恢复上次会话：服务端保留完整上下文，续聊不另起孤儿会话
  useEffect(() => {
    void refreshSessions();
    try {
      const saved = localStorage.getItem(SESSION_STORAGE_KEY);
      if (saved && /^\d+$/.test(saved)) {
        const id = Number(saved);
        setSessionId(id);
        void loadSession(id);
      }
    } catch {
      // localStorage 不可用（隐私模式等）时静默降级
    }
  }, [refreshSessions, loadSession]);

  const submitMessage = useCallback(
    async (textOverride?: string, opts?: { editingId?: string }) => {
      const text = (textOverride ?? input).trim();
      if (!text || loading) return;
      setInput("");
      setError(null);
      setLoading(true);

      // 编辑重发：不追加新用户消息（本地已截断并更新内容），服务端同样处理
      const editing = opts?.editingId ?? null;
      const optimisticId = `local-${Date.now()}`;
      const turnMsgId = `turn-${Date.now()}`;
      if (!editing) {
        setMessages((prev) => [...prev, { id: optimisticId, role: "user", content: text }]);
      }
      // 单条助手消息：思考块 + 正文共用同一气泡列，避免「回复两次」
      setMessages((prev) => [
        ...prev,
        {
          id: turnMsgId,
          role: "assistant" as const,
          content: "",
          processing: { tools: [], active: true, thinking: true },
        },
      ]);

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionId ?? undefined,
            message: text,
            stream: true,
            editingId: editing ? Number(editing.replace("hist-", "")) : undefined,
          }),
        });

        // 非流式失败响应（400/503/500）→ 与旧逻辑一致处理
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          // 服务端错误会携带已创建的 sessionId：保留它，失败重试续用同一会话而非创建孤儿会话
          if (data.sessionId) {
            setSessionId(data.sessionId);
            persistSession(data.sessionId);
          }
          if (res.status === 503) {
            setError("研究助手未配置：请在 设置 → 模型 中填写 API Key，或设置 LLM_API_KEY 环境变量。");
          } else {
            setError(data.error || `请求失败（HTTP ${res.status}）`);
          }
          // 移除乐观渲染消息；编辑重发失败时同样清理本轮助手占位
          setMessages((prev) =>
            prev.filter((m) => m.id !== turnMsgId && (editing || m.id !== optimisticId))
          );
          return;
        }

        // ── SSE 流式读取：单条 turn 消息承载 processing + 正文 ──
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamText = "";
        let doneSessionId: number | null = null;

        const updateTurn = (updater: (m: ChatItem) => ChatItem) => {
          setMessages((prev) => prev.map((m) => (m.id === turnMsgId ? updater(m) : m)));
        };

        const handleEvent = (event: string, payload: any) => {
          if (event === "context_compact_start") {
            updateTurn((m) => ({
              ...m,
              processing: {
                tools: m.processing?.tools ?? [],
                active: true,
                thinking: false,
                compaction: {
                  status: "running" as const,
                  summarizedCount: payload.messageCount,
                },
              },
            }));
          } else if (event === "context_compact_end") {
            updateTurn((m) => ({
              ...m,
              processing: {
                tools: m.processing?.tools ?? [],
                active: true,
                thinking: !payload.failed,
                compaction: payload.failed
                  ? {
                      status: "failed" as const,
                      summarizedCount: payload.messageCount,
                    }
                  : {
                      status: "done" as const,
                      summarizedCount: payload.messageCount,
                      summary: payload.summary,
                    },
              },
            }));
          } else if (event === "tool_start") {
            streamText = "";
            updateTurn((m) => ({
              ...m,
              content: "",
              processing: {
                tools: [
                  ...(m.processing?.tools ?? []),
                  {
                    name: payload.tool,
                    args: payload.args || {},
                    status: "running" as const,
                  },
                ],
                active: true,
                thinking: false,
                ...(m.processing?.compaction ? { compaction: m.processing.compaction } : {}),
              },
            }));
          } else if (event === "tool_end") {
            updateTurn((m) => {
              if (!m.processing) return m;
              const tools = [...m.processing.tools];
              for (let i = tools.length - 1; i >= 0; i--) {
                if (tools[i].status !== "done" && tools[i].status !== "error") {
                  tools[i] = {
                    ...tools[i],
                    status: payload.ok ? "done" : "error",
                    summary: payload.summary,
                  };
                  break;
                }
              }
              return {
                ...m,
                processing: { ...m.processing, tools, active: true, thinking: true },
              };
            });
          } else if (event === "delta") {
            streamText += payload.text || "";
            const display = stripToolProtocolFromAnswer(streamText);
            const jsonTail =
              looksLikeJson(streamText.trim()) ||
              (streamText.includes("\n") && /"tool"/.test(streamText.split("\n").pop() ?? ""));

            updateTurn((m) => ({
              ...m,
              content: display,
              processing: m.processing
                ? {
                    ...m.processing,
                    thinking: jsonTail && !display,
                    active: true,
                  }
                : undefined,
            }));
          } else if (event === "done") {
            doneSessionId = payload.sessionId;
            const reply = stripToolProtocolFromAnswer(payload.reply || streamText || "");
            const toolLogs: NonNullable<ChatItem["toolLog"]> = payload.toolLog || [];

            updateTurn((m) => {
              const tools = (m.processing?.tools ?? []).map((t, i) => {
                const log = toolLogs[i];
                if (!log || log.name !== t.name) return t;
                return {
                  ...t,
                  status: log.ok ? ("done" as const) : ("error" as const),
                  summary: log.summary || t.summary,
                };
              });
              const compaction = m.processing?.compaction;
              const hasProcessing = tools.length > 0 || compaction;
              return {
                ...m,
                content: reply,
                truncated: Boolean(payload.truncated),
                processing: hasProcessing
                  ? {
                      tools,
                      active: false,
                      thinking: false,
                      ...(compaction ? { compaction } : {}),
                    }
                  : undefined,
              };
            });

            // 无工具、无压缩也无正文 → 移除空占位
            if (!reply && !payload.toolLog?.length) {
              setMessages((prev) => {
                const turn = prev.find((m) => m.id === turnMsgId);
                if (turn?.processing?.compaction) return prev;
                return prev.filter((m) => m.id !== turnMsgId);
              });
            }

            if (!editing && payload.userMessageId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === optimisticId
                    ? { ...m, id: `hist-${payload.userMessageId}` }
                    : m
                )
              );
            }
          } else if (event === "error") {
            setError(payload.error || "研究助手暂时不可用，请稍后再试");
            updateTurn((m) =>
              m.processing
                ? { ...m, processing: { ...m.processing, active: false, thinking: false } }
                : m
            );
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            let evt = "";
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) evt = line.slice(6).trim();
              else if (line.startsWith("data:")) data = line.slice(5).trim();
            }
            if (!evt || !data) continue;
            try {
              handleEvent(evt, JSON.parse(data));
            } catch {
              // 忽略无法解析的事件块
            }
          }
        }

        if (doneSessionId) {
          setSessionId(doneSessionId);
          persistSession(doneSessionId);
          void refreshSessions();
        } else {
          updateTurn((m) =>
            m.processing
              ? { ...m, processing: { ...m.processing, active: false, thinking: false } }
              : m
          );
        }
      } catch (e) {
        console.error("Agent request failed:", e);
        setError("网络错误，请稍后重试");
        setMessages((prev) =>
          prev.filter((m) => m.id !== turnMsgId && (editing || m.id !== optimisticId))
        );
      } finally {
        setLoading(false);
        inputRef.current?.focus();
      }
    },
    [input, loading, sessionId, persistSession, refreshSessions]
  );

  // 编辑用户消息重发：本地截断该条之后的全部消息 → 更新内容 → 走编辑重发接口
  const sendEdit = useCallback(
    async (m: ChatItem, draft: string) => {
      const text = draft.trim();
      if (!text || loading) return;
      setEditingId(null);
      setEditingDraft("");
      setMessages((prev) => {
        const idx = prev.findIndex((x) => x.id === m.id);
        if (idx < 0) return prev;
        // 保留该条及其之前的消息，更新内容，清除之后所有回复
        return [...prev.slice(0, idx), { ...prev[idx], content: text }];
      });
      await submitMessage(text, { editingId: m.id });
    },
    [loading, submitMessage]
  );

  const send = useCallback(() => {
    void submitMessage();
  }, [submitMessage]);

  const newSession = useCallback(() => {
    setSessionId(null);
    persistSession(null);
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  }, [persistSession]);

  // 删除历史会话：成功后从列表移除；若删除的是当前会话则回到空状态
  const handleDeleteSession = useCallback(
    async (id: number) => {
      try {
        const res = await fetch(`/api/agent-sessions?id=${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        setError("会话删除失败，请稍后重试");
        throw new Error("delete failed");
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (sessionId === id) newSession();
    },
    [sessionId, newSession]
  );

  const handleRenameSession = useCallback(async (id: number, title: string) => {
    try {
      const res = await fetch(`/api/agent-sessions?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "会话重命名失败，请稍后重试");
      throw e;
    }
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title } : s))
    );
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 中文输入法组合期间(拼音选词)的 Enter 不应发送
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send]
  );

  const isEmpty = messages.length === 0 && !loading && !loadingHistory;

  return (
    <>
      <Head>
        <title>研究助手 — 财经信号</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="AI 研究助手 — 政策、行业、事件线索问答" />
      </Head>

      <AppShell
        title="研究助手"
        subtitle="基于真实信号数据的问答 · 政策 · 行业 · 事件线索"
        scrollable={false}
        sidebarExtra={
          <SessionSidebarGroup
            sessions={sessions}
            currentId={sessionId}
            query={query}
            onQuery={setQuery}
            onSelect={(id) => void loadSession(id)}
            onNew={newSession}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
          />
        }
      >
        {/* 消息流（自身滚动，输入区贴底） */}
        <div className="agent-scroll min-h-0 flex-1 overflow-y-auto">
            <style jsx global>{`
              .agent-scroll::-webkit-scrollbar { width: 6px; }
              .agent-scroll::-webkit-scrollbar-thumb {
                background: var(--border);
                border-radius: 3px;
              }
              .agent-scroll::-webkit-scrollbar-track { background: transparent; }
            `}</style>

            {/* 内容列宽度随分辨率阶梯放大；空对话时整列垂直居中提示块 */}
            <div
              className={cn(
                "mx-auto max-w-[760px] lg:max-w-[880px] xl:max-w-[960px] 2xl:max-w-[1120px] px-4 sm:px-6 py-6",
                (isEmpty || loadingHistory) && "flex min-h-full flex-col items-center justify-center"
              )}
            >
              {error && (
                <Alert variant="destructive" className="mb-5">
                  <AlertTitle>请求失败</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-5">
              {loadingHistory && (
                <div className="flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="ml-2 text-xs">正在加载会话…</span>
                </div>
              )}

              {isEmpty && (
                <div className="w-full text-center">
                  <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary mb-4">
                    <MessageSquareText className="h-6 w-6" />
                  </span>
                  <p className="text-sm text-foreground font-medium">想研究点什么？</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    可以试试这些方向，或直接输入你的问题
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2 mt-5">
                    {SUGGESTIONS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => void submitMessage(q)}
                        disabled={loading}
                        className={cn(
                          "rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground",
                          "transition-colors hover:text-foreground hover:border-primary/50 hover:bg-accent",
                          "disabled:opacity-40"
                        )}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m) => {
                if (m.role === "system") {
                  return (
                    <div key={m.id} className="text-center text-xs text-muted-foreground py-1">
                      {m.content}
                    </div>
                  );
                }

                const isUser = m.role === "user";
                const isAssistant = m.role === "assistant";

                if (isAssistant) {
                  const processing =
                    m.processing ??
                    (m.toolCall
                      ? { tools: [m.toolCall], active: false, thinking: false }
                      : undefined);
                  const showProcessing =
                    processing &&
                    (processing.active ||
                      processing.thinking ||
                      processing.tools.length > 0 ||
                      processing.compaction);
                  const hasContent = Boolean(m.content.trim());

                  if (!showProcessing && !hasContent) return null;

                  return (
                    <div key={m.id} className="group flex items-start gap-3">
                      <AgentAvatar />
                      <div className="flex min-w-0 max-w-[85%] flex-col gap-2.5">
                        {showProcessing && processing && (
                          <AgentProcessingBlock processing={processing} />
                        )}
                        {hasContent && (
                          <>
                            <div className="markdown-body text-sm leading-7 text-foreground">
                              <ReactMarkdown
                                remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                                components={MARKDOWN_COMPONENTS}
                              >
                                {m.content}
                              </ReactMarkdown>
                            </div>
                            {m.truncated && !loading && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="w-fit"
                                onClick={() => void submitMessage(CONTINUE_ANALYSIS_MESSAGE)}
                              >
                                继续分析
                              </Button>
                            )}
                            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover-none:opacity-100">
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => void copyMessage(m.id, m.content)}
                                aria-label="复制回复"
                              >
                                {copiedId === m.id ? (
                                  <>
                                    <Check className="text-positive" />
                                    已复制
                                  </>
                                ) : (
                                  <>
                                    <Copy />
                                    复制
                                  </>
                                )}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => void shareConversation()}
                                aria-label="分享会话"
                                title="生成会话分享链接"
                              >
                                {copiedId === "share" ? (
                                  <>
                                    <Check className="text-positive" />
                                    已复制
                                  </>
                                ) : (
                                  <>
                                    <Share2 />
                                    分享
                                  </>
                                )}
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                }

                // 仅带数据库 id 的历史消息可编辑（乐观/流式消息等服务端落库后替换为 hist-*）
                const editable = isUser && m.id.startsWith("hist-");
                const isEditing = editingId === m.id;
                return (
                  <div
                    key={m.id}
                    className="group flex justify-end gap-3"
                  >
                    <div className="flex max-w-[85%] flex-col items-end gap-1 text-sm">
                      <div className="leading-relaxed rounded-tl-2xl rounded-bl-2xl rounded-br-2xl rounded-tr-none bg-primary px-3 py-2 text-primary-foreground shadow-sm">
                        {isEditing ? (
                          <div className="flex flex-col">
                            <Textarea
                              value={editingDraft}
                              onChange={(e) => setEditingDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  void sendEdit(m, editingDraft);
                                } else if (e.key === "Escape") {
                                  setEditingId(null);
                                  setEditingDraft("");
                                }
                              }}
                              rows={Math.max(2, m.content.split("\n").length)}
                              maxLength={2000}
                              autoFocus
                              className="min-h-0 resize-y border-0 bg-transparent px-0 py-0 text-primary-foreground shadow-none focus-visible:ring-0 placeholder:text-primary-foreground/60"
                            />
                            <div className="mt-2 flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingId(null);
                                  setEditingDraft("");
                                }}
                                className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-primary-foreground/80 transition-colors hover:bg-primary-foreground/10"
                              >
                                <X className="size-3.5" />
                                取消
                              </button>
                              <button
                                type="button"
                                onClick={() => void sendEdit(m, editingDraft)}
                                disabled={loading || !editingDraft.trim()}
                                className="inline-flex h-6 items-center gap-1 rounded-md bg-primary-foreground px-2 text-[11px] font-medium text-primary transition-opacity hover:opacity-90 disabled:opacity-40"
                              >
                                <Send className="size-3.5" />
                                发送
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="whitespace-pre-wrap">{m.content}</div>
                        )}
                      </div>
                      {!isEditing && (
                        <div className="flex flex-row items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover-none:opacity-100">
                          {editable && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() => {
                                setEditingDraft(m.content);
                                setEditingId(m.id);
                              }}
                              disabled={loading}
                              aria-label="编辑消息"
                            >
                              <Pencil />
                              编辑
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => void copyMessage(m.id, m.content)}
                            aria-label="复制消息"
                          >
                            {copiedId === m.id ? (
                              <>
                                <Check className="text-positive" />
                                已复制
                              </>
                            ) : (
                              <>
                                <Copy />
                                复制
                              </>
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {loading && !messages.some((m) => m.processing?.active) && (
                <div className="flex items-start gap-3">
                  <AgentAvatar />
                  <div className="inline-flex items-center gap-2 rounded-xl bg-card px-3.5 py-2.5 text-sm text-muted-foreground ring-1 ring-foreground/10">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在连接…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
              </div>{/* space-y-5 消息列表 */}
              </div>{/* max-w 消息流容器 */}
            </div>{/* agent-scroll 滚动区 */}

            {/* 输入区：水平边距与消息流对齐，收紧内层留白 */}
            <div className="shrink-0 bg-background px-4 pb-4 pt-3 sm:px-6 sm:pb-5">
              <div className="mx-auto max-w-[760px] lg:max-w-[880px] xl:max-w-[960px] 2xl:max-w-[1120px]">
                <div className="flex items-end gap-1.5 rounded-2xl border bg-card py-2 pl-3 pr-2 shadow-sm transition-all focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
                  <Textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="询问政策影响、行业趋势、事件进展…（Enter 发送，Shift+Enter 换行）"
                    rows={1}
                    maxLength={2000}
                    className="max-h-[200px] min-h-9 flex-1 resize-none overflow-hidden border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:ring-0"
                  />
                  <Button
                    size="icon"
                    className="mb-0.5 h-9 w-9 shrink-0 rounded-xl"
                    onClick={send}
                    disabled={loading || loadingHistory || !input.trim()}
                    aria-label="发送"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <p className="mt-2.5 px-1 text-center text-xs text-muted-foreground">
                  AI 输出基于历史信号数据整理，仅供参考，不构成投资建议
                </p>
              </div>
            </div>
      </AppShell>
    </>
  );
}
