import { cn } from "@/lib/utils";

function Textarea({ className = undefined, ref = undefined, ...props }) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-base transition-colors md:text-sm",
        "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
