"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { Plus } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DASHBOARD_NAV, isActive } from "@/components/layout/nav-items";
import { fetcher } from "@/lib/client/api";

/** New-post button + nav list. Shared by the desktop sidebar and the mobile drawer. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data: inbox } = useSWR<{ open: number }>("/api/comments/summary", fetcher, { refreshInterval: 5 * 60_000 });
  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/dashboard/compose"
        onClick={onNavigate}
        className={cn(buttonVariants({ variant: "brand", size: "lg" }), "h-10 w-full rounded-xl text-sm")}
      >
        <Plus aria-hidden /> New post
      </Link>
      <nav aria-label="Dashboard" className="flex flex-col gap-1">
        {DASHBOARD_NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
              {href === "/dashboard/inbox" && inbox && inbox.open > 0 && (
                <span className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 text-[11px] leading-5 tabular-nums" aria-label={`${inbox.open} need a reply`}>
                  {inbox.open > 99 ? "99+" : inbox.open}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
