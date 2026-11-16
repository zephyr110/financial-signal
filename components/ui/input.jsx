import { cn } from "@/lib/utils";

function Input({ className = undefined, type = "text", ref = undefined, ...props }) {
  return (
    <input
      ref={ref}
      data-slot="input"
      type={type}
      className={cn(
        "flex h-9 w-full rounded-lg border border-border bg-transparent px-3 py-1 text-base transition-colors md:text-sm",
        "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Input };
