"use client";

import Link from "next/link";
import { Check, Plus, RefreshCw } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatformGlyph } from "@/components/platform-icon";
import type { PublicAccount } from "@/lib/accounts";
import { PLATFORM_META } from "@/lib/platforms/meta";
import { cn } from "@/lib/utils";

export function AccountPicker({
  accounts,
  loading,
  selected,
  onToggle,
}: {
  accounts: PublicAccount[] | undefined;
  loading: boolean;
  selected: ReadonlySet<string>;
  onToggle: (account: PublicAccount) => void;
}) {
  if (loading) {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
    );
  }
  if (!accounts || accounts.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4">
        <p className="text-muted-foreground text-sm">You have not connected an account yet. Connect Instagram, YouTube or LinkedIn to start scheduling.</p>
        <Link href="/dashboard/accounts" className={cn(buttonVariants({ variant: "brand" }), "h-8 rounded-lg px-3")}>
          <Plus aria-hidden /> Connect an account
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Accounts to post to">
        {accounts.map((a) => {
          const on = selected.has(a.id);
          const broken = a.status !== "connected";
          return (
            <li
              key={a.id}
              className={cn(
                "flex items-center gap-2 rounded-xl border p-2.5 transition-colors",
                on ? "border-primary bg-accent" : "hover:bg-muted/60",
                broken && "opacity-70",
              )}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={broken}
                onClick={() => onToggle(a)}
                className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-3 disabled:cursor-not-allowed"
              >
                <span className="relative">
                  <Avatar className="size-9">
                    {a.profileImageUrl && <AvatarImage src={a.profileImageUrl} alt="" />}
                    <AvatarFallback>{(a.displayName ?? a.username ?? "?").slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span
                    className="ring-background absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full text-white ring-2"
                    style={{ backgroundColor: PLATFORM_META[a.platform].color }}
                  >
                    <PlatformGlyph platform={a.platform} className="size-2.5" />
                  </span>
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium">{a.displayName ?? a.username}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {broken ? "Needs reconnecting" : a.username ? `@${a.username}` : PLATFORM_META[a.platform].name}
                  </span>
                </span>
                {on && (
                  <span className="bg-primary text-primary-foreground flex size-5 shrink-0 items-center justify-center rounded-full">
                    <Check className="size-3" aria-hidden />
                  </span>
                )}
              </button>
              {broken && (
                <a
                  href={`/api/oauth/${a.platform}/start?reconnect=${a.id}`}
                  className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
                >
                  <RefreshCw className="size-3" aria-hidden /> Reconnect
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <Link href="/dashboard/accounts" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
        <Plus className="size-3" aria-hidden /> Connect another account
      </Link>
    </div>
  );
}
