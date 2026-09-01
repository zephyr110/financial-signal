import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * 响应式断点订阅。用 useSyncExternalStore 替代 useState+useEffect:
 * 后者首帧 isMobile=undefined → !!undefined=false → 先渲染桌面布局再切移动
 * 布局(闪烁/FOUC);useSyncExternalStore 在 hydration 首帧同步读取真实值,
 * 无中间帧。SSR(服务端渲染)下返回桌面布局,不访问 window。
 */
function subscribe(callback) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function getServerSnapshot() {
  return false;
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
