import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  alt?: string;
};

/** White mark on transparent; invert on light theme, native white on dark. */
// 相邻已有可见品牌名时图片是装饰；图标态的链接自己带 aria-label。
export default function BrandLogo({ className, alt = "" }: BrandLogoProps) {
  return (
    <img
      src="/logo.png"
      alt={alt}
      className={cn("shrink-0 invert dark:invert-0", className)}
    />
  );
}
