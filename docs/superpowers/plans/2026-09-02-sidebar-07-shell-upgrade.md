# sidebar-07 外壳升级(NavMain 嵌套导航 + 面包屑顶栏)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把全局 App 外壳升级为 shadcn sidebar-07 完整形态——「信号分析」折叠子项 = 页内区块导航(滚动高亮),顶栏改为面包屑式(h-16,rail 折叠 h-12),全部 AppShell 页面共用,页面内容区排布不动。

**Architecture:** 分析页经 AppShell 新 prop `crumbs` + `sectionNav` 上报导航数据;AppShell 持有 `activeSection` state,以 props 下发:侧栏「信号分析」Collapsible 子项(内置 `useSectionSpy`,沿用现有 hook)与顶栏面包屑 leaf(=当前区块)共享同一状态。新增纯函数 `resolveCrumbs`(lib/nav-crumbs.ts)承担 crumbs 组装逻辑,可单测。

**Tech Stack:** Next.js 16 Pages Router(TSX 页面 + JSX 组件)、shadcn base-nova(base-ui,无 `asChild`,用 `render`)、Tailwind v4、vitest + testing-library(jsdom)。

## Global Constraints

- 代码风格:组件文件 `.jsx`(TS 仅 `lib/` 与 `pages/`);base-ui 用 `render` prop,不用 `asChild`。
- 不改页面内容区排布、不改登录页、不加 TeamSwitcher/NavProjects、不动 AvatarMenu 功能、新闻快讯/研究助手不加子项、价值验证报告不进侧栏(维持分析页底部链接)。
- 「信号分析」区块子项仅当页面传入 `sectionNav` 时渲染 → 只存在于 `/analysis`;因此**不需要** hash 落地滚动逻辑(spec 中的跨页锚点跳转场景不存在)。
- 分析页区块 id/标签以 `pages/analysis.tsx` 的 `navItems` 为准(概览/图表/情感分布/行业热度趋势/事件线索/信号有效性回测/信号时间线,部分条件渲染)。
- 顶栏滚动容器与 section 的 `scroll-mt-28`、spy 的 `rootMargin: "-56px 0px -60% 0px"` **一律不动**(避免高亮行为漂移)。
- 提交走 husky 钩子(自动跑 `pnpm test`),提交信息沿用仓库中文规范 `fix(ui):`/`feat(ui):`/`refactor(ui):`。
- `docs/` 在 .gitignore 中,新增文档用 `git add -f`。
- 验证命令:`pnpm typecheck` / `pnpm lint` / `pnpm test`(现状 322 测试全绿)。

**Spec 对照(spec 的简化与唯一偏差):** spec §1 的「非 /analysis 页点击子项 → 跳 /analysis#区块 + hash 落地 effect」因「子项仅随 sectionNav 渲染」的架构而消失(无子项可点);面包屑 leaf 由 `sectionNav` 合成(末段 crumb 动态化),无 href 的自我链接段降级为纯文本。

---

### Task 1: `lib/nav-crumbs.ts` 纯函数 resolveCrumbs(TDD)

**Files:**
- Create: `lib/nav-crumbs.ts`
- Test: `tests/nav-crumbs.test.ts`(跟随仓库既有顶层 tests/*.test.ts 布局)

**Interfaces:**
- Produces(后续任务依赖):
  - `export type Crumb = { label: string; href?: string }`
  - `export type SectionNavItem = { id: string; label: string }`
  - `export function resolveCrumbs(opts: { crumbs: Crumb[]; sectionItems?: SectionNavItem[] | null; activeSection?: string | null; pathname: string }): Crumb[]`
- 语义(与 spec §2 映射表一致):
  1. 结果 = `crumbs` 副本;若有 `sectionItems`(仅 /analysis 传)则**追加**末段 `{ label: 当前区块 }`(label = `sectionItems.find(id===activeSection)?.label ?? sectionItems[0].label`)。
  2. `href === pathname` 的段去掉 href(当前页自链无意义;使 /analysis 上的「信号分析」段降为纯文本)。
  3. 不改变页面的其它 crumb。

- [ ] **Step 1: 写失败测试**

`tests/nav-crumbs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveCrumbs, type Crumb, type SectionNavItem } from "../lib/nav-crumbs";

const SECTIONS: SectionNavItem[] = [
  { id: "overview", label: "概览" },
  { id: "charts", label: "图表" },
  { id: "sentiment", label: "情感分布" },
];

describe("resolveCrumbs", () => {
  it("无 sectionNav 时原样返回 crumbs", () => {
    const crumbs: Crumb[] = [{ label: "信号分析", href: "/analysis" }, { label: "价值验证报告" }];
    expect(resolveCrumbs({ crumbs, pathname: "/analytics/value" })).toEqual(crumbs);
  });

  it("有 sectionNav 时追加末段=当前区块;默认第一个区块", () => {
    const crumbs: Crumb[] = [{ label: "财经信号", href: "/" }, { label: "信号分析", href: "/analysis" }];
    expect(resolveCrumbs({ crumbs, sectionItems: SECTIONS, activeSection: null, pathname: "/analysis" }))
      .toEqual([...crumbs, { label: "概览" }]);
    expect(resolveCrumbs({ crumbs, sectionItems: SECTIONS, activeSection: "charts", pathname: "/analysis" }))
      .toEqual([...crumbs, { label: "图表" }]);
  });

  it("href 等于当前 pathname 的段降级为纯文本(去掉 href)", () => {
    const crumbs: Crumb[] = [{ label: "财经信号", href: "/" }, { label: "信号分析", href: "/analysis" }];
    const out = resolveCrumbs({ crumbs, sectionItems: SECTIONS, activeSection: "overview", pathname: "/analysis" });
    expect(out[1]).toEqual({ label: "信号分析" }); // 无 href
    expect(out[0]).toEqual({ label: "财经信号", href: "/" }); // 非当前页保留
  });

  it("详情页(无 sectionNav)保留父级链接,pathname 不匹配则不降级", () => {
    const crumbs: Crumb[] = [{ label: "信号分析", href: "/analysis" }, { label: "信号详情" }];
    expect(resolveCrumbs({ crumbs, pathname: "/signal/123" })).toEqual(crumbs);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/nav-crumbs.test.ts`
Expected: FAIL — 找不到模块 `../lib/nav-crumbs`(Cannot find module)。

- [ ] **Step 3: 实现**

`lib/nav-crumbs.ts`:

```ts
/**
 * AppShell 顶栏面包屑数据组装(纯函数,便于单测)。
 * 页面传「静态 crumbs(末项即当前页或父级链)」;分析页额外传 sectionNav,
 * 由其 items 合成末段「当前区块」leaf。
 */
export type Crumb = { label: string; href?: string };
export type SectionNavItem = { id: string; label: string };

export function resolveCrumbs({
  crumbs,
  sectionItems = null,
  activeSection = null,
  pathname,
}: {
  crumbs: Crumb[];
  sectionItems?: SectionNavItem[] | null;
  activeSection?: string | null;
  pathname: string;
}): Crumb[] {
  const out = crumbs.map((c) => (c.href === pathname ? { label: c.label } : { ...c }));
  if (sectionItems && sectionItems.length > 0) {
    const active =
      sectionItems.find((s) => s.id === activeSection) ?? sectionItems[0];
    out.push({ label: active.label });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/nav-crumbs.test.ts`
Expected: PASS(4 个用例)。

- [ ] **Step 5: 提交**

```bash
git add lib/nav-crumbs.ts tests/nav-crumbs.test.ts
git commit -m "feat(ui): resolveCrumbs 面包屑组装纯函数(区块 leaf 合成 + 自链降级)"
```

---

### Task 2: 新增 `components/ui/breadcrumb.jsx`

**Files:**
- Create: `components/ui/breadcrumb.jsx`

**Interfaces:**
- Produces: `Breadcrumb / BreadcrumbList / BreadcrumbItem / BreadcrumbLink(render 支持) / BreadcrumbPage / BreadcrumbSeparator`(base-nova 风格;比 registry 少 BreadcrumbEllipsis,无人使用,YAGNI)。

- [ ] **Step 1: 创建组件**(纯展示,无独立测试——行为由 Task 3 的 AppTopbar 测试覆盖)

`components/ui/breadcrumb.jsx`:

```jsx
import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

function Breadcrumb({ className, ...props }) {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" className={cn(className)} {...props} />;
}

function BreadcrumbList({ className, ...props }) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn("flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

function BreadcrumbLink({ className, render, ...props }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps(
      {
        className: cn("transition-colors hover:text-foreground", className),
      },
      props
    ),
    render,
    state: { slot: "breadcrumb-link" },
  });
}

function BreadcrumbPage({ className, ...props }) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn("font-normal text-foreground", className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ children, className, ...props }) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("[&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? <ChevronRight className="size-3.5 shrink-0" />}
    </li>
  );
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
};
```

- [ ] **Step 2: 验证**

Run: `npx eslint components/ui/breadcrumb.jsx && pnpm typecheck`
Expected: 0 errors / exit 0。

- [ ] **Step 3: 提交**

```bash
git add components/ui/breadcrumb.jsx
git commit -m "feat(ui): 新增 base-nova 风格 breadcrumb 组件"
```

---

### Task 3: AppShell crumbs/sectionNav 通道 + AppTopbar 面包屑化(带测试)

**Files:**
- Modify: `components/app-shell.jsx`(全文重写见下,61 行)
- Modify: `components/app-topbar.jsx`(全文重写)
- Test: `tests/components/app-topbar.test.tsx`(仿 `tests/components/index.test.tsx` 的 mock 模式)

**Interfaces:**
- Consumes: Task 1 `resolveCrumbs/Crumb/SectionNavItem`;Task 2 breadcrumb 组件。
- Produces:
  - `AppShell` 新 props:`crumbs?: Crumb[]`(默认 `[]`)、`sectionNav?: { items: SectionNavItem[]; scrollRoot: HTMLElement | null } | null`;**移除** `title`/`subtitle`。内部 state `activeSection`,`activeSection`/`onSectionChange` 经 props 下发给 AppSidebar(Task 4 消费);`AppTopbar` 新签名 `{ crumbs, actions }`。
  - `AppTopbar` 保留导出 `TopbarRefreshButton`(pages/index、pages/analysis 在用)。

- [ ] **Step 1: 写失败测试**(新 AppTopbar API 尚不存在)

`tests/components/app-topbar.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AppTopbar from "../../components/app-topbar";
import { SidebarProvider } from "../../components/ui/sidebar";

// AppTopbar 内部用 next/link 渲染 href 段,测试环境给最小桩
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={typeof href === "string" ? href : href.pathname} {...props}>
      {children}
    </a>
  ),
}));

// jsdom 无 window.matchMedia(ui/sidebar 的 use-mobile 需要),最小桩
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const renderTopbar = (crumbs: { label: string; href?: string }[]) =>
  render(
    <SidebarProvider>
      <AppTopbar crumbs={crumbs} actions={null} />
    </SidebarProvider>
  );

describe("AppTopbar 面包屑", () => {
  it("leaf(末段)渲染为 BreadcrumbPage:aria-current=page", () => {
    renderTopbar([{ label: "信号分析", href: "/analysis" }, { label: "信号详情" }]);
    const page = screen.getByRole("link", { name: "信号详情" });
    expect(page).toHaveAttribute("aria-current", "page");
  });

  it("href 段渲染为可点击链接", () => {
    renderTopbar([{ label: "信号分析", href: "/analysis" }, { label: "事件线索" }]);
    expect(screen.getByRole("link", { name: "信号分析" })).toHaveAttribute("href", "/analysis");
  });

  it("无 href 的单段(首页)也以 page 呈现", () => {
    renderTopbar([{ label: "新闻快讯" }]);
    expect(screen.getByRole("link", { name: "新闻快讯" })).toHaveAttribute("aria-current", "page");
  });

  it("单段时不渲染分隔符", () => {
    const { container } = renderTopbar([{ label: "研究助手" }]);
    expect(container.querySelector('[data-slot="breadcrumb-separator"]')).toBeNull();
  });
});
```

注:leaf 是 `<span role="link" aria-current="page">`,多段时 href 段是 `<a>`;`getByRole("link", { name: "信号详情" })` 在多 link 下按 name 精确定位。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/components/app-topbar.test.tsx`
Expected: FAIL(AppTopbar 无 `crumbs` prop,`actions` 未定义或渲染不符)。

- [ ] **Step 3: 重写 `components/app-shell.jsx`**

```jsx
import { useMemo, useState, useEffect, useRef, useContext, createContext } from "react";
import { useRouter } from "next/router";
import { SidebarInset, SidebarProvider } from "./ui/sidebar";
import AppSidebar from "./app-sidebar";
import AppTopbar from "./app-topbar";
import { resolveCrumbs } from "@/lib/nav-crumbs";

// 内容滚动容器 ref——首页下拉刷新读 scrollTop、区块导航 IntersectionObserver 传 root
const AppShellScrollContext = createContext(null);
export function useAppShellScroll() {
  return useContext(AppShellScrollContext);
}

/**
 * 全局 App 壳(sidebar-07 完整形态):
 * 左侧全局侧栏(导航分组 + 信号分析页内区块子项 + 页面专属分组)+ 右侧列(面包屑顶栏 + 内容滚动区)。
 * crumbs:面包屑数据(末项当前页);sectionNav:仅 /analysis 传入,驱动侧栏子项与顶栏 leaf。
 * activeSection:滚动监听出的当前区块 id,AppShell 持有后下发侧栏高亮与面包屑 leaf。
 * scrollable=false 时(agent 页)滚动容器改为 flex-col 透传,页面管理自身滚动。
 */
export default function AppShell({
  crumbs = [],
  sectionNav = null,
  actions = null,
  sidebarExtra = null,
  scrollable = true,
  children,
}) {
  const scrollRef = useRef(null);
  const router = useRouter();
  const [activeSection, setActiveSection] = useState(null);

  // 会话过期兜底:middleware 只在导航时校验,页面停留期间会话失效时由这里跳回登录页
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => {
        if (r.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(router.asPath)}`);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const displayCrumbs = useMemo(
    () =>
      resolveCrumbs({
        crumbs,
        sectionItems: sectionNav?.items ?? null,
        activeSection: sectionNav ? activeSection : null,
        pathname: router.pathname,
      }),
    [crumbs, sectionNav, activeSection, router.pathname]
  );

  return (
    <SidebarProvider className="flex h-dvh min-h-0 w-full overflow-hidden">
      <AppSidebar
        sectionNav={sectionNav}
        activeSection={sectionNav ? activeSection : null}
        onSectionChange={setActiveSection}
        sidebarExtra={sidebarExtra}
      />
      <SidebarInset className="min-w-0 flex-1 overflow-hidden">
        <AppTopbar crumbs={displayCrumbs} actions={actions} />
        <AppShellScrollContext.Provider value={scrollRef}>
          {scrollable ? (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-none">
              {children}
            </div>
          ) : (
            <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col">
              {children}
            </div>
          )}
        </AppShellScrollContext.Provider>
      </SidebarInset>
    </SidebarProvider>
  );
}
```

- [ ] **Step 4: 重写 `components/app-topbar.jsx`**

```jsx
import { Fragment } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { SidebarTrigger } from "./ui/sidebar";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb";
import { cn } from "@/lib/utils";

/**
 * 右侧列顶栏(sidebar-07 block 形态):折叠钮 | 竖分隔 | 面包屑 + 右侧 actions。
 * 展开 h-16,rail 折叠(data-collapsible=icon)时 h-12;面包屑首段在窄屏隐藏。
 * 位于滚动容器之外,固定高度,无 sticky/滚动监听。
 */
export default function AppTopbar({ crumbs = [], actions = null }) {
  const hasCrumbs = crumbs.length > 0;
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b bg-background px-3 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 sm:px-4">
      <SidebarTrigger
        className="-ml-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="切换侧栏"
      />
      {hasCrumbs && (
        <>
          <Separator orientation="vertical" className="hidden h-4 sm:block" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {crumbs.map((crumb, i) => {
                const isLast = i === crumbs.length - 1;
                const isLink = !isLast && crumb.href;
                const hiddenXs = i === 0 && crumbs.length > 1;
                return (
                  <Fragment key={`crumb-${i}`}>
                    {i > 0 && (
                      <BreadcrumbSeparator
                        className={cn("shrink-0", i === 1 && hiddenXs && "hidden sm:flex")}
                      />
                    )}
                    <BreadcrumbItem className={cn(hiddenXs && "hidden sm:inline-flex")}>
                      {isLink ? (
                        <BreadcrumbLink render={<Link href={crumb.href} className="no-underline" />}>
                          {crumb.label}
                        </BreadcrumbLink>
                      ) : isLast ? (
                        <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                      ) : (
                        <span className="transition-colors hover:text-foreground">{crumb.label}</span>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </>
      )}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

export function TopbarRefreshButton({ onClick, refreshing, label = "刷新数据" }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={refreshing}
      className={cn(
        "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        !refreshing && "active:scale-95"
      )}
      title={label}
      aria-label={label}
    >
      <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
    </Button>
  );
}
```

说明:
- `ml-auto` 从原「标题行容器」移到了 actions 外层 div——crumbs 不撑满时不把 actions 顶到最右则多余,故 actions 区自身 `ml-auto` 保留在 breadcrumb 之后(等价原布局)。
- leaf 与分隔符之外还有一类「无 href 且非末段」= 自链被降级的段(/analysis 上的「信号分析」),渲染为纯文本 span。
- `actions &&` 判断:share/login 等页可能无 actions,避免空 div 挤占。

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run tests/components/app-topbar.test.tsx`
Expected: PASS(4 个用例)。

- [ ] **Step 6: 验证 + 提交**

Run: `npx eslint components/app-shell.jsx components/app-topbar.jsx && pnpm typecheck`
Expected: 0 errors / exit 0(`pages/*.tsx` 仍传 `title=` → typecheck 会报错,**下一步 Task 5/6 统一迁移,若本步 typecheck 失败属预期**,可先 `pnpm typecheck 2>&1 | grep -c error` 确认报错仅来自 title/subtitle 调用点)。

```bash
git add lib components/app-shell.jsx components/app-topbar.jsx tests/components/app-topbar.test.tsx
git commit -m "feat(ui): AppShell crumbs/sectionNav 通道 + 面包屑顶栏 h-16/h-12"
```

---

### Task 4: AppSidebar「信号分析」折叠子项 + SectionNavChildren 渲染器

**Files:**
- Modify: `components/app-sidebar.jsx`
- Create: `components/SectionNavChildren.jsx`
- Delete: `components/SectionNavGroup.jsx`(由本任务末步删除;引用方 analysis 页在 Task 5 移除)

**Interfaces:**
- Consumes: AppShell(Task 3)下发 props:`sectionNav = { items, scrollRoot } | null`、`activeSection: string | null`、`onSectionChange: (id: string | null) => void`;`ContentNav.tsx` 的 `useSectionSpy`(原样复用,勿改);`useAppShellScroll`(app-shell)。
- Produces:
  - `AppSidebar` 新 props 透传上述三项(sidebarExtra 等原有 props 不变)。
  - `components/SectionNavChildren.jsx`:`export default function SectionNavChildren({ items, scrollRoot = null })`——渲染 `SidebarMenuSub` 子项行,内部 `useSectionSpy` + 乐观高亮 + 平滑滚动;`active` 变化时经 props 冒泡 `onSectionChange`(由 AppSidebar 转传)。

- [ ] **Step 1: 创建 `components/SectionNavChildren.jsx`**

把原 SectionNavGroup 的 spy/滚动逻辑原样搬入,渲染层改为 SidebarMenuSub 子项(删除 SidebarGroup 壳与 Collapsible 自管理——外层 Collapsible 由 AppSidebar 提供):

```jsx
import { useEffect } from "react";
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";
import { useSectionSpy } from "./ContentNav";
import { useAppShellScroll } from "./app-shell";
import { cn } from "@/lib/utils";

/**
 * 「信号分析」NavMain 折叠子项:7 个页内区块行(scroll-spy 高亮 + 点击平滑滚动)。
 * 由 AppSidebar 在 CollapsibleContent > SidebarMenuSub 内渲染;
 * active 区块冒泡给 AppShell(onSectionChange)→ 顶栏面包屑 leaf 联动。
 * 逻辑源自原 SectionNavGroup(独立「页面内容」分组),仅渲染位置迁移。
 */
export default function SectionNavChildren({ items, scrollRoot = null, onSectionChange = null }) {
  const shellScrollRef = useAppShellScroll();
  const { setOpenMobile } = useSidebar();
  const { active, setActive } = useSectionSpy(items, {
    root: scrollRoot ?? shellScrollRef?.current ?? null,
    rootMargin: "-56px 0px -60% 0px",
  });

  // 冒泡:AppShell 需要同一 active 驱动顶栏面包屑 leaf
  useEffect(() => {
    onSectionChange?.(active);
  }, [active, onSectionChange]);

  if (!items || items.length === 0) return null;

  const scrollTo = (id) => {
    setOpenMobile(false); // 移动端点击后关闭抽屉
    // 乐观置位:区块已在视口内时 IO 不会回调,需立即高亮(滚动动画期间 IO 再校正)
    setActive(id);
    onSectionChange?.(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <SidebarMenuSub>
      {items.map((item) => {
        const isActive = active === item.id;
        return (
          <SidebarMenuSubItem key={item.id}>
            <SidebarMenuSubButton
              isActive={isActive}
              onClick={() => scrollTo(item.id)}
              render={<button type="button" aria-current={isActive ? "true" : undefined} />}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  isActive ? "bg-sidebar-primary" : "bg-transparent"
                )}
              />
              <span>{item.label}</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        );
      })}
    </SidebarMenuSub>
  );
}
```

注:`render={<button type="button" .../>}` 把默认 `<a>` 换成按钮(滚动动作,无导航);`aria-current` 经 render 元素属性传递。

- [ ] **Step 2: 改造 `components/app-sidebar.jsx`**

改动点(a→d 四处,给出精确 diff):

a. 文件头加 `ChevronRight`、`Collapsible*`、`SectionNavChildren` 导入,加 props 接收:

```jsx
import { ChevronRight, Newspaper, TrendingUp, Bot } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import SectionNavChildren from "./SectionNavChildren";
import BrandLogo from "./BrandLogo";
import AvatarMenu from "./avatar-menu";
```

b. NAV_ITEMS 增加稳定 id(children 判定用):每项加 `id` 字段——`{ id: "news", href: "/", ... }`、`{ id: "analysis", href: "/analysis", ... }`、`{ id: "agent", href: "/agent", ... }`。

c. 组件签名与主体(替换整段函数体,含折叠分支):

```jsx
/**
 * 全局侧栏(sidebar-07 折叠分区模式):
 * Header 品牌 → 主导航(信号分析在 /analysis 时展开页内区块子项)→ 页面专属分组
 * (sidebarExtra)→ Footer(头像菜单:设置/主题/GitHub/退出)。
 * sectionNav/activeSection/onSectionChange 由 AppShell 下发,仅 /analysis 非空。
 */
export default function AppSidebar({
  sidebarExtra = null,
  sectionNav = null,
  activeSection = null,
  onSectionChange = null,
  ...props
}) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const closeOnMobile = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>{/* 品牌区:不变,省略,见下一条注记 */}</SidebarHeader>

      <SidebarContent className="gap-1">
        <SidebarGroup className="gap-1">
          <SidebarGroupLabel className="mb-1">导航</SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {NAV_ITEMS.map((item) => {
              const active = item.match(router.pathname);
              const hasSections = item.id === "analysis" && sectionNav?.items?.length > 0;

              if (hasSections) {
                // 信号分析(/analysis):折叠父项,子项 = 页内区块(滚动联动)
                return (
                  <SidebarMenuItem key={item.href}>
                    <Collapsible defaultOpen className="group/collapsible">
                      <CollapsibleTrigger
                        render={
                          <SidebarMenuButton
                            tooltip={item.label}
                            isActive={active}
                            aria-current={active ? "page" : undefined}
                            className="py-2.5 data-active:!bg-sidebar-primary/10 data-active:!text-sidebar-primary"
                          />
                        }
                      >
                        <item.icon />
                        <span>{item.label}</span>
                        <ChevronRight className="ml-auto size-4 shrink-0 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SectionNavChildren
                          items={sectionNav.items}
                          scrollRoot={sectionNav.scrollRoot}
                          onSectionChange={onSectionChange}
                        />
                      </CollapsibleContent>
                    </Collapsible>
                  </SidebarMenuItem>
                );
              }

              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className="no-underline"
                      />
                    }
                    isActive={active}
                    tooltip={item.label}
                    onClick={closeOnMobile}
                    className="py-2.5 data-active:!bg-sidebar-primary/10 data-active:!text-sidebar-primary"
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {sidebarExtra}
      </SidebarContent>

      <SidebarFooter className="gap-0 p-0">
        <SidebarMenu className="px-2 py-2">
          <AvatarMenu />
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
```

注:SidebarHeader 品牌按钮与 SidebarFooter 保持原文件内容不动(本 diff 用占位注释标示,合入时保留原 JSX)。

d. 行为说明(实现后自查):
- 非 /analysis 路由:无 sectionNav → 「信号分析」走普通链接分支(点击导航到 /analysis)。
- /analysis:Collapsible `defaultOpen` 常开(每次挂载都是新实例);折叠 rail 时 `SidebarMenuSub` 自带 `group-data-[collapsible=icon]:hidden`,父项变 icon+tooltip(触发按钮已带 tooltip)。
- 点击父项行:仅展开/收起(当前就在 /analysis,无需导航);点击子项:乐观高亮 + 平滑滚动 + 移动端关抽屉。

- [ ] **Step 3: 删除 `components/SectionNavGroup.jsx`**

(analysis.tsx 尚引用 → Task 5 删除引用后本文件才可安全移除;此处先保留文件,Task 5 Step 2 统一删除。)

- [ ] **Step 4: 验证**

Run: `npx eslint components/app-sidebar.jsx components/SectionNavChildren.jsx && pnpm test`
Expected: eslint 0 errors;322 tests PASS(SectionNavGroup 未被引用测试,删除不影响;typecheck 阶段 title 报错仍属预期,Task 5 清理)。

- [ ] **Step 5: 提交**

```bash
git add components/app-sidebar.jsx components/SectionNavChildren.jsx
git commit -m "feat(ui): 侧栏 NavMain——信号分析折叠子项(区块导航 + 滚动联动)"
```

---

### Task 5: 迁移 `pages/analysis.tsx`(crumbs + sectionNav,移除 SectionNavGroup)

**Files:**
- Modify: `pages/analysis.tsx`

**Interfaces:**
- Consumes: AppShell(Task 3)新 props;`lib/nav-crumbs` 的 `Crumb` 类型(可选标注)。
- Produces: 首个完整使用新通道的页面;删掉 `SectionNavGroup` import 与 `sidebarExtra` 用法。

- [ ] **Step 1: 修改 AppShell 调用点(约 264-268 行)**

原:

```tsx
      <AppShell
        title="信号分析"
        scrollable={false}
        actions={<TopbarRefreshButton onClick={doRefresh} refreshing={fetching} />}
        sidebarExtra={<SectionNavGroup items={navItems} scrollRoot={scrollRoot} />}
      >
```

新:

```tsx
      <AppShell
        crumbs={[
          { label: "财经信号", href: "/" },
          { label: "信号分析", href: "/analysis" },
        ]}
        scrollable={false}
        actions={<TopbarRefreshButton onClick={doRefresh} refreshing={fetching} />}
        sectionNav={{ items: navItems, scrollRoot }}
      >
```

- [ ] **Step 2: 删除 import**

原(文件头附近):`import SectionNavGroup from "../components/SectionNavGroup";`(以实际 import 路径为准)→ 整行删除。随后删除文件 `components/SectionNavGroup.jsx`:

```bash
rm components/SectionNavGroup.jsx
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过(此刻 title/subtitle 残留只剩其余 6 个页面,Task 6 处理;若仍有其它报错,以 grep 确认全部是 title/subtitle 调用点)。

- [ ] **Step 4: 提交**

```bash
git add pages/analysis.tsx && git rm components/SectionNavGroup.jsx
git commit -m "refactor(ui): 分析页接入 crumbs/sectionNav,移除独立页面内容分组"
```

---

### Task 6: 迁移其余 6 个 AppShell 页面到 crumbs

**Files:**
- Modify: `pages/index.tsx`(1 处调用)
- Modify: `pages/agent.tsx`(1 处)
- Modify: `pages/agent/s/[token].tsx`(1 处)
- Modify: `pages/signal/[id].tsx`(3 处:loading/error/main)
- Modify: `pages/thread/[id].tsx`(3 处)
- Modify: `pages/analytics/value.tsx`(1 处)

**Interfaces:**
- Consumes: AppShell(Task 3)`crumbs`;类型 `Crumb` 无需显式导入(字面量结构兼容)。

- [ ] **Step 1: `pages/index.tsx`**(约 231 行)

原:`title="新闻快讯"` → 新:`crumbs={[{ label: "新闻快讯" }]}`(actions 等其余 props 不动)。

- [ ] **Step 2: `pages/agent.tsx`**(约 474-476 行)

原:

```tsx
      <AppShell
        title="研究助手"
        subtitle="基于真实信号数据的问答 · 政策 · 行业 · 事件线索"
        scrollable={false}
```

新:

```tsx
      <AppShell
        crumbs={[{ label: "研究助手" }]}
        scrollable={false}
```

(副标题文本不再显示于顶栏——spec 决定,内容区原有说明文案不受影响。)

- [ ] **Step 3: `pages/agent/s/[token].tsx`**(约 29 行)

原:`<AppShell title="会话分享" subtitle={notFound ? undefined : title}>`
新:`<AppShell crumbs={[{ label: "会话分享" }]}>`

- [ ] **Step 4: `pages/signal/[id].tsx`**(3 处,55/72/109 行附近)

每处 `title="信号详情"` → `crumbs={[{ label: "信号分析", href: "/analysis" }, { label: "信号详情" }]}`(三处相同)。

- [ ] **Step 5: `pages/thread/[id].tsx`**(3 处,81/97/131 行附近)

每处 `title="事件线索"` → `crumbs={[{ label: "信号分析", href: "/analysis" }, { label: "事件线索" }]}`(三处相同)。

- [ ] **Step 6: `pages/analytics/value.tsx`**(约 48 行)

原:`<AppShell title="价值验证报告">`
新:

```tsx
      <AppShell
        crumbs={[
          { label: "信号分析", href: "/analysis" },
          { label: "价值验证报告" },
        ]}
      >
```

- [ ] **Step 7: 全局验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过(0 errors;322 tests PASS)。另 grep 确认无残留:

Run: `grep -rn "title=\|subtitle=" pages/ --include="*.tsx" | grep -v "<title>\|<meta"` → 期望无 AppShell 相关输出(仅剩 `<Head>` 内的 `<title>` 标签合法)。

- [ ] **Step 8: 提交**

```bash
git add pages/index.tsx pages/agent.tsx pages/agent/s/[token].tsx pages/signal/[id].tsx pages/thread/[id].tsx pages/analytics/value.tsx
git commit -m "refactor(ui): 全部页面迁移到 crumbs 面包屑传参"
```

---

### Task 7: 端到端验证 + 手工清单

**Files:**
- 无代码改动(仅验证)

- [ ] **Step 1: 全量静态检查**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 0 errors / exit 0 / 322 tests PASS。

- [ ] **Step 2: 启动 dev 服务器并逐页冒烟(HTML 可渲染 + 无编译错)**

```bash
pnpm dev > /tmp/financial-signal-dev.log 2>&1 &
```

等 `Ready` 后:

Run: `curl -s http://localhost:3000/analysis | grep -o "信号分析" | head -1`(期望命中;再依次 curl `/`、`/agent`、`/analytics/value`、`/login`)。日志无 ERROR 后结束进程(`kill %1`)。

- [ ] **Step 3: 生产构建(spec §验证第 3 条)**

先停 dev 服务器,再:

Run: `pnpm build`
Expected: 构建成功输出(`Compiled successfully` / routes 列表);ISR/SSG 页面数据流不受外壳改动影响(prebuild verify-data 在 DB 不可达时自动降级,不会阻断)。

- [ ] **Step 4: 手工视觉清单(需要浏览器/桌面端,由用户或接续任务执行)**

对照 spec §验证:
- [ ] 首页:顶栏「新闻快讯」leaf,无多余分隔符;折叠 rail 后顶栏 h-12、面包屑仍在。
- [ ] /analysis:面包屑「财经信号 › 信号分析 › 概览」;滚动时末段联动(图表/情感分布/…);侧栏子项同源高亮;点击子项平滑滚动;rail 折叠后子项隐藏、父项 icon+tooltip。
- [ ] 从 /signal/<id> 返回:面包屑「信号分析(链回)→ 信号详情」;侧栏「信号分析」父项高亮但无子项。
- [ ] /agent、会话分享、价值报告面包屑正确;分享页无 subtitle 后顶栏简洁。
- [ ] 移动端宽度(~375px):抽屉内子项点击关闭抽屉;顶栏首段隐藏、leaf 常显;actions 不换行。
- [ ] 深/浅色主题下 breadcrumb/子项高亮对比度正常。

- [ ] **Step 5: 提交本计划与 spec(未在 Task 中提交过时)**

```bash
git add -f docs/superpowers/plans/2026-09-02-sidebar-07-shell-upgrade.md
git commit -m "docs(plan): sidebar-07 外壳升级实现计划"
```
