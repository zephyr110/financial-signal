import { useState, useEffect, useRef, useCallback, isValidElement } from "react";
import Head from "next/head";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquareText, Send, Wrench, Loader2, Bot, CheckCircle2, XCircle, ChevronRight, Copy, Check, Share2, Pencil, X } from "lucide-react";
import AppShell from "../components/app-shell";
import SessionSidebarGroup from "../components/SessionSidebarGroup";
import AgentCodeBlock from "../components/agent-code-block";

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

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  /** 流式工具执行状态：tool_end 事件到达后由 running 变为 done/error */
  status?: "running" | "done" | "error";
  summary?: string;
}

interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCall?: ToolCallInfo;
  toolLog?: { name: string; args: Record<string, unknown>; ok: boolean; summary: string }[];
}

interface SessionSummary {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_STORAGE_KEY = "agent-session-id";

/**
 * 服务端消息（agent_message.meta）→ 前端 ChatItem：
 * - assistant 消息带 meta.toolCall → 工具调用卡片
 * - user 的内部工具结果消息（【工具 X 结果】）→ 附加为上一个工具卡片的 toolLog 摘要
 * - 其余按原文渲染
 */
function historyToChatItems(rows: any[]): ChatItem[] {
  const out: ChatItem[] = [];
  for (const r of rows) {
    if (r.role === "user" && r.content.startsWith("【工具")) {
      const last = out[out.length - 1];
      if (last?.toolCall && r.meta?.toolResult) {
        last.toolLog = [
          {
            name: r.meta.toolResult.name,
            args: {},
            ok: r.meta.toolResult.ok,
            summary: String(r.meta.toolResult.content || "").slice(0, 60),
          },
        ];
      }
      continue;
    }
    const item: ChatItem = { id: `hist-${r.id}`, role: r.role, content: r.content };
    if (r.meta?.toolCall) {
      // 历史工具调用必然已执行完毕；旧数据 meta 无 status → 兜底 done，避免永久显示"执行中"
      item.toolCall = { ...r.meta.toolCall, status: r.meta.toolCall.status || "done" };
    }
    out.push(item);
  }
  return out;
}

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
      if (!editing) {
        setMessages((prev) => [...prev, { id: optimisticId, role: "user", content: text }]);
      }

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
            setError("研究助手未配置：请设置 LLM_API_KEY 环境变量（或 DEEPSEEK_API_KEY）。");
          } else {
            setError(data.error || `请求失败（HTTP ${res.status}）`);
          }
          // 移除乐观渲染的 user 消息，让用户重试（编辑重发时无乐观消息，跳过）
          if (!editing) setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
          return;
        }

        // ── SSE 流式读取：tool_start → delta… → done ──
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamMsgId: string | null = null;
        let streamText = "";
        let toolLogs: ChatItem["toolLog"] = [];
        let doneSessionId: number | null = null;

        const handleEvent = (event: string, payload: any) => {
          if (event === "tool_start") {
            // 工具调用 JSON 的 delta 已累积在流式消息中 → 移除并替换为工具气泡
            if (streamMsgId) {
              setMessages((prev) => prev.filter((m) => m.id !== streamMsgId));
              streamMsgId = null;
              streamText = "";
            }
            setMessages((prev) => [
              ...prev,
              {
                id: `tool-${Date.now()}-${payload.tool}`,
                role: "assistant" as const,
                content: "",
                toolCall: {
                  name: payload.tool,
                  args: payload.args || {},
                  status: "running",
                } as ToolCallInfo,
              },
            ]);
          } else if (event === "tool_end") {
            // 更新最后一条执行中的工具卡片（SSE 顺序 = 工具执行顺序，单 agent 串行执行）
            setMessages((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                const m = prev[i];
                if (m.toolCall && m.toolCall.status !== "done" && m.toolCall.status !== "error") {
                  const next = [...prev];
                  next[i] = {
                    ...m,
                    toolCall: {
                      ...m.toolCall,
                      status: payload.ok ? "done" : "error",
                      summary: payload.summary,
                    },
                  };
                  return next;
                }
              }
              return prev;
            });
          } else if (event === "delta") {
            streamText += payload.text || "";
            if (!streamMsgId) {
              streamMsgId = `stream-${Date.now()}`;
              setMessages((prev) => [...prev, { id: streamMsgId!, role: "assistant", content: "" }]);
            }
            setMessages((prev) =>
              prev.map((m) => (m.id === streamMsgId ? { ...m, content: streamText } : m))
            );
          } else if (event === "done") {
            doneSessionId = payload.sessionId;
            toolLogs = payload.toolLog || [];
            // 最终回复以服务端确定性管道输出为准（含截断标注）。流式累积文本只作
            // 兜底——工具调用 JSON 的 delta 残留（格式错误回喂/参数错误等路径）不应
            // 成为回复内容
            const reply = payload.reply || streamText || "";
            // 乐观用户消息替换为数据库消息（拿到真实 id，后续编辑重发可用）
            if (!editing && payload.userMessageId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === optimisticId
                    ? { ...m, id: `hist-${payload.userMessageId}` }
                    : m
                )
              );
            }
            // 工具日志附加到最终回复气泡：有流式消息则就地更新为服务端回复，否则新建
            setMessages((prev) =>
              streamMsgId
                ? prev.map((m) => (m.id === streamMsgId ? { ...m, content: reply, toolLog: toolLogs } : m))
                : [...prev, { id: `reply-${Date.now()}`, role: "assistant" as const, content: reply, toolLog: toolLogs }]
            );
          } else if (event === "error") {
            setError(payload.error || "研究助手暂时不可用，请稍后再试");
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
          // 新会话/续聊都会更新标题与时间 → 刷新侧栏列表
          void refreshSessions();
        } else if (streamMsgId) {
          // 流中断（超时/网络断开）但已有内容：保留已显示的部分
          setMessages((prev) =>
            prev.map((m) => (m.id === streamMsgId ? { ...m, toolLog: toolLogs } : m))
          );
        }
      } catch (e) {
        console.error("Agent request failed:", e);
        setError("网络错误，请稍后重试");
        if (!editing) setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
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
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (sessionId === id) newSession();
    },
    [sessionId, newSession]
  );

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
            onDelete={(id) => void handleDeleteSession(id)}
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
                if (m.toolCall) {
                  return (
                    <div key={m.id} className="flex justify-start pl-10">
                      <div className="max-w-[85%]">
                        <details className="group/tool rounded-xl border bg-muted/40 open:bg-muted/60">
                          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground select-none list-none [&::-webkit-details-marker]:hidden">
                            <Wrench className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-medium text-foreground">调用工具： {m.toolCall.name}</span>
                            {m.toolCall.status === "done" ? (
                              <span className="ml-auto inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                完成
                              </span>
                            ) : m.toolCall.status === "error" ? (
                              <span className="ml-auto inline-flex items-center gap-1 text-destructive">
                                <XCircle className="h-3.5 w-3.5" />
                                失败
                              </span>
                            ) : (
                              <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                执行中…
                              </span>
                            )}
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open/tool:rotate-90" />
                          </summary>
                          <div className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-300 ease-in-out group-open/tool:grid-rows-[1fr] group-open/tool:opacity-100">
                            <div className="overflow-hidden">
                              <pre className="mx-3 mb-2 overflow-x-auto rounded-md bg-background px-2.5 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
                                {JSON.stringify(m.toolCall.args, null, 2)}
                              </pre>
                            </div>
                          </div>
                        </details>
                        {m.toolLog && m.toolLog.length > 0 && (
                          <div className="mt-1.5 rounded-xl border bg-muted/20 px-3 py-2 space-y-1.5">
                            {m.toolLog.map((t, i) => (
                              <ToolLogRow key={i} t={t} />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }
                const isUser = m.role === "user";
                // 仅带数据库 id 的历史消息可编辑（乐观/流式消息等服务端落库后替换为 hist-*）
                const editable = isUser && m.id.startsWith("hist-");
                const isEditing = editingId === m.id;
                return (
                  <div
                    key={m.id}
                    className={cn(
                      "group flex gap-3",
                      isUser ? "justify-end" : "items-start justify-start"
                    )}
                  >
                    {!isUser && (
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Bot className="h-4 w-4" />
                      </span>
                    )}
                    <div
                      className={cn(
                        "max-w-[85%] text-sm",
                        isUser
                          ? // 用户气泡：primary 蓝（明暗主题自适应）+ 右上角直角，其余三角保持圆角
                            "leading-relaxed rounded-tl-2xl rounded-bl-2xl rounded-br-2xl rounded-tr-none bg-primary px-4 py-2.5 text-primary-foreground shadow-sm"
                          : "leading-7 text-foreground"
                      )}
                    >
                      {isUser && isEditing ? (
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
                      {!isUser && (
                        <>
                          <div className="markdown-body">
                            <ReactMarkdown
                              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                              components={MARKDOWN_COMPONENTS}
                            >
                              {m.content}
                            </ReactMarkdown>
                          </div>
                          {/* 操作行：复制 + 分享（靠左） */}
                          <div className="mt-2 flex items-center justify-start gap-0.5">
                            <button
                              type="button"
                              onClick={() => void copyMessage(m.id, m.content)}
                              className={cn(
                                "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground",
                                "transition-colors hover:bg-accent hover:text-foreground"
                              )}
                              aria-label="复制回复"
                            >
                              {copiedId === m.id ? (
                                <>
                                  <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                                  已复制
                                </>
                              ) : (
                                <>
                                  <Copy className="size-3.5" />
                                  复制
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => void shareConversation()}
                              className={cn(
                                "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground",
                                "transition-colors hover:bg-accent hover:text-foreground"
                              )}
                              aria-label="分享会话"
                              title="生成会话分享链接"
                            >
                              {copiedId === "share" ? (
                                <>
                                  <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                                  已复制
                                </>
                              ) : (
                                <>
                                  <Share2 className="size-3.5" />
                                  分享
                                </>
                              )}
                            </button>
                          </div>
                        </>
                      )}
                      {m.toolLog && m.toolLog.length > 0 && (
                        <div className="mt-2.5 pt-2.5 border-t border-foreground/10 space-y-1.5">
                          {m.toolLog.map((t, i) => (
                            <ToolLogRow key={i} t={t} />
                          ))}
                        </div>
                      )}
                    </div>
                    {/* 用户气泡操作按钮：在气泡外部右侧、底部对齐
                        （桌面 hover 显示；触屏 hover 不可用则常显） */}
                    {isUser && !isEditing && (
                      <div className="flex shrink-0 flex-col justify-end gap-0.5 self-end opacity-0 transition-opacity group-hover:opacity-100 hover-none:opacity-100">
                        {editable && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingDraft(m.content);
                              setEditingId(m.id);
                            }}
                            disabled={loading}
                            className={cn(
                              "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground",
                              "transition-colors hover:bg-accent hover:text-foreground",
                              loading && "opacity-40"
                            )}
                            aria-label="编辑消息"
                          >
                            <Pencil className="size-3.5" />
                            编辑
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void copyMessage(m.id, m.content)}
                          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          aria-label="复制消息"
                        >
                          {copiedId === m.id ? (
                            <>
                              <Check className="size-3.5 text-emerald-500" />
                              已复制
                            </>
                          ) : (
                            <>
                              <Copy className="size-3.5" />
                              复制
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {loading && (
                <div className="flex items-start justify-start gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Bot className="h-4 w-4" />
                  </span>
                  <div className="inline-flex h-7 items-center gap-2 text-sm leading-7 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在研究…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
              </div>{/* space-y-5 消息列表 */}
              </div>{/* max-w 消息流容器 */}
            </div>{/* agent-scroll 滚动区 */}

            {/* 输入区（大圆角容器 + 内嵌发送，无分割线） */}
            <div className="shrink-0 bg-background px-4 py-3 sm:py-4">
              <div className="mx-auto max-w-[760px] lg:max-w-[880px] xl:max-w-[960px] 2xl:max-w-[1120px]">
                <div className="flex items-end gap-2 rounded-2xl border bg-card p-3 shadow-sm transition-all focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
                  <Textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="询问政策影响、行业趋势、事件进展…（Enter 发送，Shift+Enter 换行）"
                    rows={1}
                    maxLength={2000}
                    className="min-h-[104px] max-h-[200px] flex-1 resize-none border-0 bg-transparent px-2 py-4 shadow-none focus-visible:ring-0"
                  />
                  <Button
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-xl"
                    onClick={send}
                    disabled={loading || loadingHistory || !input.trim()}
                    aria-label="发送"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  AI 输出基于历史信号数据整理，仅供参考，不构成投资建议
                </p>
              </div>
            </div>
      </AppShell>
    </>
  );
}

/** 工具日志行：单行截断展示，展开后显示完整内容（grid-rows 过渡动画）。 */
function ToolLogRow({ t }: { t: { name: string; ok: boolean; summary: string } }) {
  return (
    <details className="group/log">
      <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 text-xs [&::-webkit-details-marker]:hidden">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            t.ok ? "bg-emerald-500" : "bg-destructive"
          )}
          aria-hidden
        />
        <Wrench className="h-3 w-3 shrink-0 opacity-70" />
        <span className="min-w-0 truncate font-medium">{t.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.summary}</span>
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open/log:rotate-90" />
      </summary>
      <div className="grid grid-rows-[0fr] transition-all duration-200 group-open/log:grid-rows-[1fr]">
        <div className="overflow-hidden">
          <div className="pt-1.5 pl-4 text-xs text-muted-foreground whitespace-pre-wrap break-all">
            {t.summary}
          </div>
        </div>
      </div>
    </details>
  );
}
