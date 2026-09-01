import { useState, useRef, useEffect, useCallback } from "react";
import { Search, X } from "lucide-react";
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
 * Search bar with score and time-range dropdowns.
 * Debounces input by 300ms before triggering search.
 */
export default function SearchBar({
  onSearch,
  onClear,
  loading = false,
  className,
}: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [minScore, setMinScore] = useState(1);
  const [hoursBack, setHoursBack] = useState(720);
  const [showScoreDropdown, setShowScoreDropdown] = useState(false);
  const [showTimeDropdown, setShowTimeDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 最新筛选值快照:防抖回调执行时可能已过了多次渲染,闭包里的旧值会让
  // 旧防抖覆盖新筛选(输入过程中改分数/时间窗)。定时器触发时一律读 ref。
  const filtersRef = useRef({ query: "", minScore: 1, hoursBack: 720 });
  filtersRef.current = { query, minScore, hoursBack };

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

  const handleClear = () => {
    setQuery("");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    inputRef.current?.focus();
    onClear?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 中文输入法组合期间(拼音选词)的 Enter 不应触发搜索
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && query.trim().length >= 2) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      triggerSearch(query, minScore, hoursBack);
    }
  };

  const handleScoreChange = (val: number) => {
    setMinScore(val);
    setShowScoreDropdown(false);
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
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (query.trim().length >= 2) {
      triggerSearch(query, minScore, val);
    }
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-dropdown]")) {
        setShowScoreDropdown(false);
        setShowTimeDropdown(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const currentScoreLabel =
    SCORE_OPTIONS.find((o) => o.value === minScore)?.label || "全部";
  const currentTimeLabel =
    TIME_OPTIONS.find((o) => o.value === hoursBack)?.label || "30 天";

  return (
    <div className={cn("flex items-stretch gap-2", className)}>
      {/* Search input */}
      <div className="relative flex-1 min-w-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="搜索行业、公司、关键词…"
          className="w-full h-9 pl-9 pr-8 rounded-lg border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {loading ? (
              <span className="inline-block h-3.5 w-3.5 border-2 border-muted-foreground/40 border-t-muted-foreground rounded-full animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Score filter dropdown */}
      <div className="relative" data-dropdown>
        <button
          type="button"
          onClick={() => {
            setShowScoreDropdown(!showScoreDropdown);
            setShowTimeDropdown(false);
          }}
          className="h-9 px-3 rounded-lg border bg-background text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors whitespace-nowrap"
        >
          {currentScoreLabel}
        </button>
        {showScoreDropdown && (
          <div className="absolute right-0 top-full mt-1 bg-card border rounded-lg shadow-lg py-1 z-20 min-w-[80px]">
            {SCORE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
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
          onClick={() => {
            setShowTimeDropdown(!showTimeDropdown);
            setShowScoreDropdown(false);
          }}
          className="h-9 px-3 rounded-lg border bg-background text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors whitespace-nowrap"
        >
          {currentTimeLabel}
        </button>
        {showTimeDropdown && (
          <div className="absolute right-0 top-full mt-1 bg-card border rounded-lg shadow-lg py-1 z-20 min-w-[80px]">
            {TIME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
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
