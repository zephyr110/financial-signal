import { useState, useEffect, useCallback } from "react";
import { industryDisplayName } from "./constants";
import { getAllWatchlist, subscribeWatchlist, toggleWatchlist, removeWatchlist, type WatchlistType } from "./watchlist";

const LEGACY_KEY = "financial-signals-watched-industries";

/**
 * 行业关注 Hook（P2.2 后基于通用 watchlist 服务）。
 * 对外 API 保持兼容：watched（行业名数组）、toggle、clearAll、filterByWatched。
 * 旧版 localStorage 格式（纯行业名数组）首次加载时迁移为 watchlist 条目。
 */
function migrateLegacy() {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return;
    const industries = JSON.parse(legacy);
    if (Array.isArray(industries)) {
      for (const ind of industries) {
        if (typeof ind === "string" && !getAllWatchlist().some((i) => i.type === "industry" && i.id === ind)) {
          // 直接写库不触发埋点（迁移非用户行为）
          const items = getAllWatchlist();
          items.push({ type: "industry" as WatchlistType, id: ind, addedAt: new Date().toISOString() });
          localStorage.setItem("financial-signals-watchlist", JSON.stringify(items));
        }
      }
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // 迁移失败不影响使用
  }
}

export function useWatchedIndustries() {
  const [watched, setWatched] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    migrateLegacy();
    setWatched(getAllWatchlist().filter((i) => i.type === "industry").map((i) => i.id));
    setLoaded(true);
    return subscribeWatchlist(() => {
      setWatched(getAllWatchlist().filter((i) => i.type === "industry").map((i) => i.id));
    });
  }, []);

  const toggle = useCallback((industry: string) => {
    toggleWatchlist("industry", industry);
  }, []);

  const clearAll = useCallback(() => {
    for (const ind of getAllWatchlist().filter((i) => i.type === "industry")) {
      removeWatchlist("industry", ind.id);
    }
  }, []);

  const filterByWatched = useCallback((items) => {
    if (!watched || watched.length === 0) return items;
    const normWatched = watched.map(industryDisplayName);
    return items.filter((item) => {
      if (!item.industries || item.industries.length === 0) return true;
      return item.industries.some((ind: string) => normWatched.includes(industryDisplayName(ind)));
    });
  }, [watched]);

  return { watched, loaded, toggle, clearAll, filterByWatched, hasFilters: watched.length > 0 };
}
