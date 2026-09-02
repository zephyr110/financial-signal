import { useEffect, useRef, useState } from "react";
import { Search, MessageSquarePlus, Trash2, Pencil, MoreHorizontal } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";

/** SQLite datetime('now')（UTC）→ 相对时间 */
function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 研究助手页侧栏分组：历史会话（sidebar-07 折叠分区模式）。
 * 顶栏：新对话 + 可展开搜索（默认仅图标）；下方会话列表。
 * icon rail 折叠时仅保留新对话入口。
 */
export default function SessionSidebarGroup({
  sessions,
  currentId,
  query,
  onQuery,
  onSelect,
  onNew,
  onDelete,
  onRename,
}) {
  const { setOpenMobile } = useSidebar();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const renameInputRef = useRef(null);

  const closeOnMobile = () => setOpenMobile(false);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => (s.title ?? "").toLowerCase().includes(q))
    : sessions;

  const openSearch = () => setSearchOpen(true);

  const closeSearch = () => {
    if (!query.trim()) setSearchOpen(false);
  };

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // 有搜索词时保持展开，避免输入后误触收起看不见关键词
  useEffect(() => {
    if (query.trim()) setSearchOpen(true);
  }, [query]);

  useEffect(() => {
    if (renameTarget) renameInputRef.current?.focus();
  }, [renameTarget]);

  const handleNew = () => {
    onNew();
    closeOnMobile();
  };

  const requestDelete = (session, e) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleteTarget(session);
  };

  const requestRename = (session, e) => {
    e.preventDefault();
    e.stopPropagation();
    setRenameTarget(session);
    setRenameDraft(session.title?.trim() || "");
  };

  const confirmRename = async () => {
    if (!renameTarget || renaming) return;
    const title = renameDraft.trim();
    if (!title) return;
    setRenaming(true);
    try {
      await onRename(renameTarget.id, title);
      setRenameTarget(null);
      setRenameDraft("");
    } catch {
      // 失败时保留对话框，错误由父组件提示
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      // 删除失败：保留对话框，错误由父组件提示
    } finally {
      setDeleting(false);
    }
  };

  const deleteTitle = deleteTarget?.title?.trim() || "未命名会话";

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>历史会话</SidebarGroupLabel>

      {/* 展开态：新对话 + 可展开搜索 + 列表 */}
      <div className="flex min-h-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
        <div className="relative mb-2 h-8">
          {/* 收起态：新对话 + 搜索图标（展开时淡出上移，隐藏焦点与指针） */}
          <div
            className={cn(
              "flex h-8 items-center gap-1 transition-all duration-300 ease-in-out",
              searchOpen && "pointer-events-none -translate-y-1 opacity-0"
            )}
            aria-hidden={searchOpen}
          >
            <button
              type="button"
              onClick={handleNew}
              tabIndex={searchOpen ? -1 : 0}
              className={cn(
                "flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-sidebar-border px-2 text-xs font-medium",
                "text-sidebar-foreground transition-opacity",
                "hover:bg-sidebar-primary/10 hover:text-sidebar-primary",
                "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-sidebar-primary"
              )}
            >
              <MessageSquarePlus />
              <span className="truncate">新对话</span>
            </button>
            <button
              type="button"
              onClick={openSearch}
              tabIndex={searchOpen ? -1 : 0}
              className={cn(
                "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground",
                "transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              )}
              aria-label="搜索会话"
            >
              <Search className="size-4" />
            </button>
          </div>

          {/* 展开态：搜索输入框（收起时淡出下移，避免遮挡新对话行） */}
          <div
            className={cn(
              "absolute inset-0 z-10 flex items-center transition-all duration-300 ease-in-out",
              !searchOpen && "pointer-events-none translate-y-1 opacity-0"
            )}
            aria-hidden={!searchOpen}
          >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <SidebarInput
              ref={searchInputRef}
              value={query}
              tabIndex={searchOpen ? 0 : -1}
              onChange={(e) => onQuery(e.target.value)}
              onBlur={closeSearch}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query.trim()) onQuery("");
                  else setSearchOpen(false);
                  searchInputRef.current?.blur();
                }
              }}
              placeholder="搜索会话…"
              className="h-8 w-full pl-8 text-xs"
              aria-label="搜索会话"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <SidebarMenu>
            {filtered.length === 0 ? (
              <SidebarMenuItem>
                <div className="py-10 text-center text-xs text-muted-foreground">
                  {sessions.length === 0 ? "暂无历史会话" : "无匹配会话"}
                </div>
              </SidebarMenuItem>
            ) : (
              filtered.map((s) => {
                const active = s.id === currentId;
                return (
                  <SidebarMenuItem key={s.id}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={s.title || "未命名会话"}
                      onClick={() => {
                        onSelect(s.id);
                        closeOnMobile();
                      }}
                      className="h-auto items-start py-1.5 pr-9"
                    >
                      <div className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "block truncate text-sm",
                            active ? "font-medium" : "text-foreground/90"
                          )}
                        >
                          {s.title || "未命名会话"}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {relTime(s.updated_at)}
                        </span>
                      </div>
                    </SidebarMenuButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <SidebarMenuAction
                            showOnHover={!active}
                            aria-label={`更多操作 ${s.title || "未命名会话"}`}
                            title="更多"
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                              "top-2 size-7 text-muted-foreground transition-colors",
                              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                              "focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground",
                              "data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground",
                              active && "md:opacity-100"
                            )}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </SidebarMenuAction>
                        }
                      />
                      <DropdownMenuContent side="bottom" align="end" className="w-36">
                        <DropdownMenuItem
                          className="cursor-pointer gap-2"
                          onClick={(e) => requestRename(s, e)}
                        >
                          <Pencil className="size-4 opacity-60" />
                          重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          className="cursor-pointer gap-2"
                          onClick={(e) => requestDelete(s, e)}
                        >
                          <Trash2 className="size-4 opacity-60" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                );
              })
            )}
          </SidebarMenu>
        </div>
      </div>

      {/* 折叠 icon rail：仅新对话 */}
      <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="新对话" onClick={handleNew}>
            <MessageSquarePlus className="text-sidebar-primary" />
            <span>新对话</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      <Dialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent showCloseButton={!deleting} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除会话？</DialogTitle>
            <DialogDescription>
              将永久删除「{deleteTitle}」及其全部消息记录，此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mx-0 mb-0 mt-2 border-t-0 bg-transparent p-0 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameTarget != null}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setRenameTarget(null);
            setRenameDraft("");
          }
        }}
      >
        <DialogContent showCloseButton={!renaming} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>为会话设置一个便于识别的标题。</DialogDescription>
          </DialogHeader>
          <Input
            ref={renameInputRef}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && renameDraft.trim() && !renaming) {
                e.preventDefault();
                void confirmRename();
              }
            }}
            placeholder="输入会话标题"
            maxLength={120}
            disabled={renaming}
            aria-label="会话标题"
          />
          <DialogFooter className="mx-0 mb-0 mt-2 border-t-0 bg-transparent p-0 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={renaming}
              onClick={() => {
                setRenameTarget(null);
                setRenameDraft("");
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={renaming || !renameDraft.trim()}
              onClick={() => void confirmRename()}
            >
              {renaming ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarGroup>
  );
}
