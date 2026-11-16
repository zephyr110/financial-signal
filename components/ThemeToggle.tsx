import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";
import { cn } from "@/lib/utils";

const toggleClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring";

interface ThemeToggleProps {
  className?: string;
}

export default function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const cycleTheme = () => {
    if (theme === "system") setTheme("dark");
    else if (theme === "dark") setTheme("light");
    else setTheme("system");
  };

  const label =
    theme === "system"
      ? "系统主题"
      : resolvedTheme === "dark"
        ? "切换为浅色"
        : "切换为深色";

  const icon = !mounted ? (
    <span className="block size-4" aria-hidden />
  ) : theme === "system" ? (
    <Monitor className="size-4" />
  ) : resolvedTheme === "dark" ? (
    <Moon className="size-4" />
  ) : (
    <Sun className="size-4" />
  );

  const buttonProps = {
    type: "button" as const,
    onClick: cycleTheme,
    disabled: !mounted,
    className: cn(toggleClass, className),
    "aria-label": mounted ? label : "切换主题",
    children: icon,
  };

  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />} />
      <TooltipContent side="right" align="center" className="">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
