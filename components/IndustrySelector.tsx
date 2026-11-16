import { useState, useRef, useEffect } from "react";
import { Settings2, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import EmptyData from "@/components/EmptyData";

/**
 * Popover selector for watched industries.
 * Shows available industries from heatmap data.
 * Selected industries persist in localStorage via useWatchedIndustries hook.
 */
export default function IndustrySelector({ industries, watched, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const available = industries || [];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all border",
          watched.length > 0
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
        )}
      >
        <Settings2 className="h-3.5 w-3.5" />
        {watched.length > 0 ? `关注 ${watched.length} 个行业` : "关注行业"}
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-2 w-72 origin-top-left animate-in rounded-xl border bg-card p-3 shadow-lg fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none sm:w-80">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-foreground">
              选择关注的行业
            </span>
            {watched.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                清除全部
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
            {available.map((ind) => {
              const active = watched.includes(ind.industry || ind);
              const name = ind.industry || ind;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => onToggle(name)}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition-all border",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/30"
                  )}
                >
                  {active && <Check className="h-3 w-3" />}
                  {name}
                  {ind.signalCount && (
                    <span className="text-xs text-muted-foreground">{ind.signalCount}</span>
                  )}
                </button>
              );
            })}
          </div>

          {available.length === 0 && (
            <EmptyData className="min-h-20 px-0 py-4" />
          )}
        </div>
      )}
    </div>
  );
}
