import { AlertCircle, CheckCircle2, Clock, FileEdit, Loader2, type LucideIcon } from "lucide-react";
import type { PostStatus, TargetStatus } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const STATUS_META: Record<PostStatus, { label: string; icon: LucideIcon; className: string; dot: string }> = {
  draft: { label: "Draft", icon: FileEdit, className: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/60" },
  scheduled: { label: "Scheduled", icon: Clock, className: "bg-primary/10 text-primary", dot: "bg-primary" },
  publishing: { label: "Publishing", icon: Loader2, className: "bg-warning/20 text-amber-700 dark:text-amber-300", dot: "bg-warning" },
  published: { label: "Published", icon: CheckCircle2, className: "bg-success/15 text-success", dot: "bg-success" },
  failed: { label: "Failed", icon: AlertCircle, className: "bg-destructive/10 text-destructive", dot: "bg-destructive" },
};

export function PostStatusBadge({ status, className }: { status: PostStatus; className?: string }) {
  const { label, icon: Icon, className: tone } = STATUS_META[status];
  return (
    <Badge variant="secondary" className={cn("gap-1 border-0", tone, className)}>
      <Icon className={cn("size-3", status === "publishing" && "animate-spin")} aria-hidden />
      {label}
    </Badge>
  );
}

const TARGET_TONE: Record<TargetStatus, string> = {
  pending: "text-muted-foreground",
  publishing: "text-amber-600 dark:text-amber-300",
  published: "text-success",
  failed: "text-destructive",
};
const TARGET_LABEL: Record<TargetStatus, string> = { pending: "Waiting", publishing: "Publishing…", published: "Published", failed: "Failed" };

export function TargetStatusText({ status, className }: { status: TargetStatus; className?: string }) {
  return <span className={cn("text-xs font-medium", TARGET_TONE[status], className)}>{TARGET_LABEL[status]}</span>;
}
