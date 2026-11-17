import { useState, useRef, useEffect, useCallback } from "react";
import { Clock, Gauge, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { track } from "@/lib/track";

const SCORE_OPTIONS = [
  { value: 1, label: "全部" },
  { value: 3, label: "≥3 分" },
  { value: 4, label: "≥4 分" },
  { value: 5, label: "5 分" },
];

const TIME_OPTIONS = [
  { value: 24, label: "24h" },
  { value: 168, label: "7 天" },
  { value: 720, label: "30 天" },
  { value: 2160, label: "90 天" },
];

interface SearchBarProps {
  onSearch: (params: {
    query: string;
    minScore: number;
    hoursBack: number;
  }) => void;
  /** 清空输入时回调（用于让父组件退出搜索态） */
  onClear?: () => void;
  loading?: boolean;
  className?: string;
}

/**
 * 搜索 + 分数 + 时间范围。搜索框默认收成一枚图标，
 * 聚焦或点击后展开，宽度动画向左生长，不挤动右侧按钮。
 */
export default function SearchBar({
  onSearch,
  onClear,
  loading = false,
  className,
}: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [minScore, setMinScore] = useState(1);
  const [hoursBack, setHoursBack] = useState(168);
  const [inputOpen, setInputOpen] = useState(false);
  const [showScoreDropdown, setShowScoreDropdown] = useState(false);
  const [showTimeDropdown, setShowTimeDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 有查询内容时必须保持展开，否则结果生效但输入框不可见，无法确认/修改
  const expanded = inputOpen || query.length > 0;

  // 最新筛选值快照:防抖回调执行时可能已过了多次渲染,闭包里的旧值会让
  // 旧防抖覆盖新筛选(输入过程中改分数/时间窗)。定时器触发时一律读 ref。
  const filtersRef = useRef({ query: "", minScore: 1, hoursBack: 168 });
  filtersRef.current = { query, minScore, hoursBack };

  // 点击图标或键盘聚焦图标后，把焦点交给真正的输入框
  useEffect(() => {
    if (inputOpen) inputRef.current?.focus();
  }, [inputOpen]);

  const triggerSearch = useCallback(
    (q: string, score: number, hours: number) => {
      if (q.trim().length < 2) return;
      track('search_query', { query: q.trim().slice(0, 100), minScore: score, hoursBack: hours });
      onSearch({ query: q.trim(), minScore: score, hoursBack: hours });
    },
    [onSearch],
  );

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (val.trim().length >= 2) {
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        const f = filtersRef.current;
        triggerSearch(f.query, f.minScore, f.hoursBack);
      }, 300);
    }
  };

  const resetSearch = () => {
    setQuery("");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    onClear?.();
  };

  const handleClear = () => {
    resetSearch();
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 中文输入法组合期间(拼音选词)的 Enter 不应触发搜索
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      resetSearch();
      setInputOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Enter" && query.trim().length >= 2) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      triggerSearch(query, minScore, hoursBack);
    }
  };

  const handleScoreChange = (val: number) => {
    setMinScore(val);
    setShowScoreDropdown(false);
    // 菜单项卸载会吞掉 focusout，空搜索框需显式收起
    if (query.trim().length === 0) setInputOpen(false);
    // 立即搜索并作废 pending 防抖,避免旧防抖随后用旧筛选值再触发一次
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (query.trim().length >= 2) {
      triggerSearch(query, val, hoursBack);
    }
  };

  const handleTimeChange = (val: number) => {
    setHoursBack(val);
    setShowTimeDropdown(false);
    if (query.trim().length === 0) setInputOpen(false);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (query.trim().length >= 2) {
      triggerSearch(query, minScore, val);
    }
  };

  // 外部点击关闭下拉；空搜索框同样收起（焦点丢失时不一定有 focusout 可用）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-dropdown]")) {
        setShowScoreDropdown(false);
        setShowTimeDropdown(false);
      }
      if (filtersRef.current.query.length === 0 && !rootRef.current?.contains(target)) {
        setInputOpen(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    // 没有查询内容时失焦即收起；有内容则保留，保证搜索态可见
    if (query.length === 0) setInputOpen(false);
  };

  const currentScoreLabel =
    SCORE_OPTIONS.find((o) => o.value === minScore)?.label || "全部";
  const currentTimeLabel =
    TIME_OPTIONS.find((o) => o.value === hoursBack)?.label || "30 天";

  const pillClass =
    "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground";

  return (
    <div ref={rootRef} className={cn("flex items-center gap-2", className)} onBlur={handleBlur}>
      {/* 搜索框：收起时是一枚圆形图标 */}
      <div
        className={cn(
          "relative flex h-8 shrink-0 items-center rounded-full border bg-card transition-[width,border-color] duration-200 ease-out",
          expanded
            ? "w-44 border-border focus-within:border-primary/50 sm:w-56"
            : "w-8 hover:border-primary/40",
        )}
        onFocusCapture={() => setInputOpen(true)}
      >
        <Search
          className={cn(
            "pointer-events-none absolute left-2.5 z-10 h-3.5 w-3.5 text-muted-foreground transition-opacity",
            expanded ? "opacity-100" : "opacity-0",
          )}
        />
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="搜索行业、公司、关键词…"
          aria-label="搜索行业、公司、关键词"
          tabIndex={expanded ? 0 : -1}
          aria-hidden={!expanded}
          className={cn(
            "h-full rounded-full border-0 bg-transparent pl-8 pr-7 text-xs shadow-none focus-visible:ring-0",
            !expanded && "pointer-events-none opacity-0",
          )}
        />
        {query && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleClear}
            aria-label="清空搜索"
            className="absolute right-2 top-1/2 z-10 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          >
            {loading ? (
              <span className="inline-block h-3.5 w-3.5 border-2 border-muted-foreground/40 border-t-muted-foreground rounded-full animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {!expanded && (
          <button
            type="button"
            aria-label="搜索"
            aria-expanded={expanded}
            onClick={() => setInputOpen(true)}
            className="absolute inset-0 flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Score filter dropdown */}
      <div className="relative" data-dropdown>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={showScoreDropdown}
          onClick={() => {
            setShowScoreDropdown(!showScoreDropdown);
            setShowTimeDropdown(false);
          }}
          className={cn(
            pillClass,
            minScore !== 1 && "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          <Gauge className="h-3.5 w-3.5" />
          {currentScoreLabel}
        </button>
        {showScoreDropdown && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 bg-card border rounded-lg shadow-lg py-1 z-20 min-w-[88px]"
          >
            {SCORE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={opt.value === minScore}
                onClick={() => handleScoreChange(opt.value)}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors",
                  opt.value === minScore
                    ? "text-foreground font-medium"
                    : "text-muted-foreground",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Time filter dropdown */}
      <div className="relative" data-dropdown>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={showTimeDropdown}
          onClick={() => {
            setShowTimeDropdown(!showTimeDropdown);
            setShowScoreDropdown(false);
          }}
          className={cn(
            pillClass,
            hoursBack !== 168 && "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          <Clock className="h-3.5 w-3.5" />
          {currentTimeLabel}
        </button>
        {showTimeDropdown && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 bg-card border rounded-lg shadow-lg py-1 z-20 min-w-[88px]"
          >
            {TIME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={opt.value === hoursBack}
                onClick={() => handleTimeChange(opt.value)}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors",
                  opt.value === hoursBack
                    ? "text-foreground font-medium"
                    : "text-muted-foreground",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
