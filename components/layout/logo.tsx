import Link from "next/link";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export function Logo({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="bg-brand flex size-8 items-center justify-center rounded-xl shadow-sm">
        <Sparkles className="size-4" aria-hidden />
      </span>
      <span className="text-lg">Social Copilot</span>
    </Link>
  );
}
