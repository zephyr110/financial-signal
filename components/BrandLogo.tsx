import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  alt?: string;
};

/** White mark on transparent; invert on light theme, native white on dark. */
export default function BrandLogo({ className, alt = "收盘手记" }: BrandLogoProps) {
  return (
    <img
      src="/logo.png"
      alt={alt}
      className={cn("shrink-0 invert dark:invert-0", className)}
    />
  );
}
