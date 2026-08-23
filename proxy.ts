import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, SESSION_COOKIE } from './lib/auth';

/**
 * 登录门卫：除公开路径外一律校验会话 cookie。
 * 公开路径：登录页、认证 API、健康探活、RSS、事件埋点、会话分享（公开只读链接）、
 * cron 接口（机器调用，以 CRON_SECRET 鉴权，不走浏览器会话）。
 * 页面未登录 → 302 到 /login?next=<原路径>；API 未登录 → 401。
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon|manifest|robots.txt).*)'],
};

// 静态资源（public/ 下的 logo、图标等）不走登录门卫，否则未登录时 /logo.png 会被
// 307 到 /login?next=/logo.png 形成循环，登录页品牌 logo 无法显示。
// 放 handler 内判定而非 matcher：matcher 正则区分大小写，/logo.PNG 会漏过门禁形成循环
const STATIC_EXT_RE = /\.(?:png|svg|jpg|jpeg|gif|webp|ico|css|woff2?|js|json|txt|pdf|mp4|webm)$/i;

const PUBLIC_PAGE = ['/login'];
const PUBLIC_API = ['/api/auth/', '/api/health', '/api/rss', '/api/events', '/api/agent-share', '/api/cron/'];
const PUBLIC_PREFIX = ['/agent/s/'];

export default async function proxy(req: NextRequest) {
  // 桌面端:本地单用户应用,跳过登录门卫
  if (process.env.DESKTOP_MODE === '1') return NextResponse.next();
  const { pathname, search } = req.nextUrl;

  if (STATIC_EXT_RE.test(pathname)) return NextResponse.next();
  if (PUBLIC_PREFIX.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (PUBLIC_PAGE.includes(pathname) || PUBLIC_API.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }
    const loginUrl = new URL(`/login?next=${encodeURIComponent(pathname + search)}`, req.url);
    return NextResponse.redirect(loginUrl);
  }

  try {
    const username = await getSessionUser(token);
    if (!username) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: '登录已过期' }, { status: 401 });
      }
      const loginUrl = new URL(`/login?next=${encodeURIComponent(pathname + search)}`, req.url);
      return NextResponse.redirect(loginUrl);
    }
  } catch (error) {
    console.error('[proxy] session check error:', error);
    // DB 不可用等异常：放行页面（页面自身 /api/auth/me 会兜底引导登录），API 保守拒绝
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: '服务暂时不可用' }, { status: 503 });
    }
  }
  return NextResponse.next();
}
