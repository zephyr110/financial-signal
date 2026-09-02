import { Bot } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** 研究助手消息头像：与 shadcn Avatar 对齐，全站统一尺寸与描边 */
export function AgentAvatar({ className }: { className?: string }) {
  return (
    <Avatar className={cn("size-7 after:border-0", className)}>
      <AvatarFallback className="bg-primary/10 text-primary">
        <Bot className="size-3.5" />
      </AvatarFallback>
    </Avatar>
  );
}
