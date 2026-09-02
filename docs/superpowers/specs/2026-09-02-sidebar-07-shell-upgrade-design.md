# 外壳升级:sidebar-07 完整形态(NavMain 嵌套导航 + 面包屑顶栏)

**日期：** 2026-09-02
**状态：** 待确认
**目标：** 参考 [shadcn sidebar-07 (new-york-v4)](https://ui.shadcn.com/view/new-york-v4/sidebar-07) 的左右布局,把全局 App 外壳升级到该 block 的完整形态:NavMain 嵌套分组导航(信号分析折叠子项 = 页内区块)、面包屑式顶栏(h-16 / rail 折叠 h-12)。**所有页面共用同一外壳,一次改造全体生效;页面内容区排布不变。**

---

## 背景与现状

`components/app-shell.jsx` 已实现 sidebar-07 的外壳骨架(`SidebarProvider > AppSidebar + SidebarInset`,侧栏 `collapsible="icon"`,`SidebarRail` 齐全),与 reference 的差距在细节:

| Reference block | 当前实现 | 差距 |
|---|---|---|
| NavMain:可折叠父项 + 子项(`SidebarMenuSub`),rail 折叠时 icon+tooltip、子项隐藏 | 三个平铺入口(新闻快讯/信号分析/研究助手),无嵌套 | 无嵌套分组;信号分析的 7 个页内区块导航是侧栏里独立的「页面内容」分组(`SectionNavGroup`) |
| 顶栏:h-16 折叠钮 \| 分隔线 \| Breadcrumb;rail 折叠时 h-12 | h-14 标题 `<p>` + 副标题 + 右侧 actions | 无面包屑;高度/折叠态不同 |
| 侧栏 Header:品牌/TeamSwitcher | 静态品牌区(logo+财经信号) | **不引入下拉**(无多团队语义,已确认) |
| NavUser 底部用户菜单 | AvatarMenu(头像+名称行+主题/设置/GitHub/退出) | 结构已等价,不动功能 |
| — | `sidebarExtra` 插槽(agent 会话列表等) | 保留机制,reference 无此概念但本应用需要 |
| — | `ui/breadcrumb.jsx` **缺失** | 需新增组件 |

分析页现状:`pages/analysis.tsx` 7 个区块各有 `id`(`overview/charts/sentiment/trend/threads/backtest/timeline`)+ `scroll-mt-28`,页内自持滚动容器(`scrollable={false}` + `contentScrollRef`),`navItems`(useMemo)与 `scrollRoot` 通过 `sidebarExtra={<SectionNavGroup items scrollRoot/>}` 注入侧栏;`SectionNavGroup` 用 `useSectionSpy`(IntersectionObserver,rootMargin `-56px 0px -60%`)驱动高亮,点击 `scrollIntoView` + 关闭移动端抽屉。

---

## 范围

**做：** AppShell / AppSidebar / AppTopbar / SectionNavGroup 改造、`pages/analysis.tsx` 传参调整、新增 `ui/breadcrumb.jsx`、7 个 AppShell 页面的顶栏传参迁移(首页、分析、价值报告、研究助手、会话分享、信号详情、事件线索)。

**不做：**
- 页面内容区的左右两栏化(维持各页单列居中排布)
- 登录页(独立布局,无 AppShell)
- 新闻快讯页加页内锚点子项;研究助手加子项;价值验证报告进入侧栏(维持分析页底部链接)
- TeamSwitcher 下拉、NavProjects 列表组件(本应用无团队/项目语义)
- AvatarMenu 功能增删

---

## 技术决策

- **架构：** 维持「页面提供区块导航数据 → 外壳渲染」方向。`app-shell.jsx` 新增可选 prop `sectionNav`,由分析页传入 `{ items: {id,label}[], getScrollRoot: () => HTMLElement | null }`;AppShell 内部用 `useState` 持有 `activeSection`,**以 props 下发给 AppSidebar 与 AppTopbar**,不新增 context(渲染器与两个消费方都处于 AppShell 子树,两层 props 透传可接受,避免新抽象)。
- **复用：** `useSectionSpy`/`scrollIntoView` 逻辑从 SectionNavGroup 原样保留,组件降级为「NavMain 子项渲染器」,不再自造「页面内容」SidebarGroup。
- **样式：** 新增 `ui/breadcrumb.jsx` 优先走 `pnpm dlx shadcn@latest add breadcrumb`(components.json: base-nova / tsx:false / base-ui 风格);若 CLI 输出与仓库既有组件(如 `dropdown-menu.jsx` 的 base-ui 写法)不一致,则按仓库风格手写(纯展示组件,无交互基元)。
- **移动端与折叠：** 复用现有 `useSidebar`(isMobile / setOpenMobile / group-data-[collapsible=icon] 分组),不新增设备逻辑。

---

## 设计

### 1. 侧栏 NavMain(components/app-sidebar.jsx)

导航结构从平铺数组升级为「入口项 + 可选子项插槽」:

```
导航
├─ 新闻快讯      (平铺,link → /)
├─ 信号分析      (Collapsible 父项:icon + 名称 + Chevron)
│   └─ SidebarMenuSub 子项(7 区块:总览/图表/情绪/趋势/事件线索/回测/时间线)
│       高亮随滚动(spy),点击滚动到区块并关移动端抽屉
└─ 研究助手      (平铺,link → /agent)
```

- 子项仅当 `sectionNav` prop 存在且父项匹配 `/analysis` 时渲染;非 /analysis 页面(信号详情/事件线索/价值报告仍属「信号分析」高亮组)时父项无子项或子项收起——子项点击此时 = 跳转 `/analysis#<区块 id>`,分析页挂载后读 `location.hash` 滚动到对应区块(`pages/analysis.tsx` 加一个 hash 落地 effect,滚动目标为其自持滚动容器)。
- rail 折叠态:`SidebarMenuSub` 列表按 reference 惯例整体 `group-data-[collapsible=icon]:hidden`,父项 icon+tooltip(现按钮已有 tooltip 机制)。
- 「信号分析」在 `/analysis` 下 `defaultOpen`;折叠状态跟随路由切换重置,不持久记忆。
- 移除原独立「页面内容」SidebarGroup;`SectionNavGroup.jsx` 改造为内部子项渲染组件(接受 `{ items, getScrollRoot, activeSection, onActiveChange, scrollTargetUrl }` 等),继续内联 observer 与点击滚动。
- `sidebarExtra`(agent 会话列表等)、SidebarRail、品牌区、AvatarMenu 位置不变。

### 2. 顶栏面包屑(components/app-topbar.jsx)

签名从 `{ title, subtitle, actions }` 改为 `{ crumbs, actions }`:

- `crumbs: { label: string; href?: string }[]`——末项为当前页 leaf(`aria-current="page"`),有 `href` 的段为导航段;首段(导航性父级)在窄屏隐藏(`hidden sm:flex` 一类),leaf 常显。
- 视觉:`SidebarTrigger` | 竖 `Separator` | Breadcrumb 组件;右侧 `ml-auto` actions 区保留(刷新等)。
- 高度:`h-16`(展开态)→ rail 折叠 `group-has-data-[collapsible=icon]/sidebar-wrapper:h-12`。
- 页面 `<p>` 标题移除(各页内容区已有自己的 h1,SEO 语义由面包屑 `<ol>` + 内容区 h1 承担)。

**每页 crumbs 映射(7 个调用点):**

| 页面 | crumbs |
|---|---|
| `/` 新闻快讯 | `新闻快讯`(leaf,无上级) |
| `/analysis` | `财经信号`(→/) › `信号分析`(→/analysis) › **当前区块**(leaf,联动滚动,默认 `总览`) |
| `/analytics/value` | `信号分析`(→/analysis) › `价值验证报告` |
| `/agent` | `研究助手`(leaf) |
| `/agent/s/[token]` | `会话分享`(leaf) |
| `/signal/[id]` | `信号分析`(→/analysis) › `信号详情` |
| `/thread/[id]` | `信号分析`(→/analysis) › `事件线索` |

AppShell prop `title/subtitle` 废弃,改收 `crumbs`(或保留 `title` 兼容 = 单段 leaf,实现时取其一,spec 定:直接迁移,不留双 API)。

### 3. 数据流

```
analysis.tsx ── sectionNav {items, getScrollRoot} + crumbs ──> AppShell
        │                                                   │
        │ useState(activeSection)                          ├─> AppSidebar:信号分析子项高亮/展开
        └─ spy 回调 onActiveChange(id|null) ◄──────────────┘
                                                   └─> AppTopbar:leaf crumb = 当前区块
```

- spy 归属:NavMain 子项渲染器内联 `useSectionSpy`(与现状相同,root = analysis 自持滚动容器)。
- 区块点击:root 存在(当前即 /analysis)→ `scrollIntoView({behavior:'smooth'})` + 关移动抽屉;root 不存在 → `router.push(/analysis#id)`,由落地 effect 处理。

### 4. 文件改动清单

| 文件 | 改动 |
|---|---|
| `components/ui/breadcrumb.jsx` | 新增(shadcn CLI 或手写,base-nova 风格) |
| `components/app-shell.jsx` | 新增 `sectionNav` prop + `activeSection` state;`title/subtitle` → `crumbs` |
| `components/app-sidebar.jsx` | NAV_ITEMS 支持 children 插槽;信号分析项 Collapsible + `SidebarMenuSub` 渲染;rail/路由联动 |
| `components/SectionNavGroup.jsx` | 改造为 NavMain 子项渲染器(去掉独立 SidebarGroup 壳),保留 spy/滚动逻辑 |
| `components/app-topbar.jsx` | 面包屑化 + h-16/h-12 + leaf 联动 |
| `pages/analysis.tsx` | 传 `sectionNav` + `crumbs`;删除 SectionNavGroup 用法;加 location.hash 落地 effect |
| `pages/index.tsx`、`agent.tsx`、`agent/s/[token].tsx`、`signal/[id].tsx`、`thread/[id].tsx`、`analytics/value.tsx` | title/subtitle 传参 → crumbs |

---

## 验证

1. `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿。
2. `pnpm dev` 手工过 8 类页面 × 关键交互:
   - 首页/价值报告/研究助手:面包屑正确显示;rail 折叠 → 顶栏变 h-12、图标 rail。
   - 信号分析:子项 7 区块随滚动高亮;顶栏 leaf 同步当前区块;点击子项平滑滚动;移动端抽屉内点击后关闭。
   - 信号详情/事件线索:父项「信号分析」高亮;面包屑链回 /analysis;点击不存在于当前页的区块场景(从详情页只能点父项,区块仅 /analysis 可见)。
   - 会话分享页(只读分享 token 路由)。
3. `pnpm build` 通过(ISR/SSG 数据流不受外壳改动影响)。

## 非目标(重申)

不做页内两栏、不动登录页、不加 TeamSwitcher/NavProjects、不改 AvatarMenu 功能、新闻页不加锚点、价值报告不进侧栏。
