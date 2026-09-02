import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";
import { useSectionSpy } from "./ContentNav";
import { useAppShellScroll } from "./app-shell";
import { cn } from "@/lib/utils";

/**
 * 信号分析页侧栏分组：页面内容区块导航（sidebar-07 折叠分区模式）。
 * Collapsible 折叠分区 + scroll-spy 高亮（滚动容器 root，-56px 顶栏带）。
 */
export default function SectionNavGroup({ items, scrollRoot = null }) {
  const shellScrollRef = useAppShellScroll();
  const { setOpenMobile } = useSidebar();
  const { active, setActive } = useSectionSpy(items, {
    root: scrollRoot ?? shellScrollRef?.current ?? null,
    rootMargin: "-56px 0px -60% 0px",
  });

  if (!items || items.length === 0) return null;

  const scrollTo = (id) => {
    setOpenMobile(false); // 移动端点击后关闭抽屉
    // 乐观置位：区块已在视口内时 IO 不会回调，需立即高亮（滚动动画期间 IO 再校正）
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <Collapsible defaultOpen className="group/collapsible group-data-[collapsible=icon]:hidden">
      <SidebarGroup>
        <SidebarGroupLabel className="cursor-pointer">
          <CollapsibleTrigger className="flex w-full items-center gap-2">
            <span>页面内容</span>
            <ChevronRight className="ml-auto size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarMenu>
            {items.map((item) => {
              const isActive = active === item.id;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    tooltip={item.label}
                    isActive={isActive}
                    onClick={() => scrollTo(item.id)}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        isActive ? "bg-sidebar-primary" : "bg-transparent"
                      )}
                    />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}
