"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Info, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatformIcon } from "@/components/platform-icon";
import { PageHeader } from "@/components/page-header";
import { PLATFORMS, type Platform } from "@/lib/constants";
import type { PublicAccount } from "@/lib/accounts";
import { api, errorMessage } from "@/lib/client/api";
import { useAccounts } from "@/lib/client/hooks";
import { oauthErrorMessage } from "@/lib/oauth-errors";
import { PLATFORM_META } from "@/lib/platforms/meta";
import { cn } from "@/lib/utils";

export function AccountsView() {
  const { data, error, isLoading, mutate } = useAccounts();
  const [toRemove, setToRemove] = useState<PublicAccount | null>(null);
  const [removing, setRemoving] = useState(false);

  // Surface the result of an OAuth round trip (?connected=... / ?error=...), then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const err = params.get("error");
    if (!connected && !err) return;
    if (connected) toast.success(`${PLATFORM_META[connected as Platform]?.name ?? "Account"} connected.`);
    if (err) toast.error(oauthErrorMessage(err), { description: params.get("detail") ?? undefined, duration: 9000 });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function confirmRemove() {
    if (!toRemove) return;
    setRemoving(true);
    try {
      await api(`/api/accounts/${toRemove.id}`, { method: "DELETE" });
      toast.success("Account disconnected.");
      setToRemove(null);
      await mutate();
    } catch (e) {
      toast.error(errorMessage(e), { duration: 8000 });
      setToRemove(null);
    } finally {
      setRemoving(false);
    }
  }

  const atLimit = data ? data.limit.used >= data.limit.max : false;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <PageHeader
        title="Accounts"
        description="Connect the social accounts you want to publish to. You can schedule one post to several platforms at once."
      />

      {data && (
        <Card>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {data.limit.used} of {data.limit.max} accounts connected
              </p>
              <p className="text-muted-foreground text-xs">
                {atLimit ? "You have reached your plan's account limit." : "Your plan's account allowance."}
              </p>
            </div>
            <Progress value={(data.limit.used / data.limit.max) * 100} className="sm:w-64" aria-label="Connected accounts" />
          </CardContent>
        </Card>
      )}

      {error && (
        <Card role="alert" className="border-destructive/40">
          <CardContent className="flex items-center gap-3 text-sm">
            <AlertTriangle className="text-destructive size-4 shrink-0" aria-hidden />
            <span className="flex-1">{errorMessage(error)}</span>
            <Button variant="outline" size="sm" onClick={() => mutate()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-2xl" />
          ))}
        </div>
      )}

      {data && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PLATFORMS.map((id) => {
            const meta = PLATFORM_META[id];
            const info = data.platforms.find((p) => p.id === id);
            const accounts = data.accounts.filter((a) => a.platform === id);
            return (
              <PlatformCard
                key={id}
                platform={id}
                implemented={info?.implemented ?? false}
                configured={info?.configured ?? false}
                accounts={accounts}
                atLimit={atLimit}
                onRemove={setToRemove}
                blurb={meta.blurb}
              />
            );
          })}
        </div>
      )}

      <AlertDialog open={toRemove !== null} onOpenChange={(open) => !open && !removing && setToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {toRemove?.username ? `@${toRemove.username}` : "this account"}?</AlertDialogTitle>
            <AlertDialogDescription>
              We will stop publishing to it and revoke our access. Posts you already published stay where they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={removing} onClick={confirmRemove}>
              {removing ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PlatformCard({
  platform,
  implemented,
  configured,
  accounts,
  atLimit,
  onRemove,
  blurb,
}: {
  platform: Platform;
  implemented: boolean;
  configured: boolean;
  accounts: PublicAccount[];
  atLimit: boolean;
  onRemove: (a: PublicAccount) => void;
  blurb: string;
}) {
  const meta = PLATFORM_META[platform];
  return (
    <Card className={cn("h-full", !implemented && "opacity-75")}>
      <CardContent className="flex h-full flex-col gap-4">
        <div className="flex items-start gap-3">
          <PlatformIcon platform={platform} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-semibold">{meta.name}</h2>
              {!implemented && <Badge variant="secondary">Coming soon</Badge>}
              {implemented && !configured && <Badge variant="outline">Not configured</Badge>}
            </div>
            <p className="text-muted-foreground text-sm">{blurb}</p>
          </div>
        </div>

        {accounts.length > 0 && (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="bg-muted/50 flex items-center gap-3 rounded-xl p-2.5">
                <Avatar className="size-9">
                  {a.profileImageUrl && <AvatarImage src={a.profileImageUrl} alt="" />}
                  <AvatarFallback>{(a.displayName ?? a.username ?? "?").slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.displayName ?? a.username}</p>
                  {a.username && <p className="text-muted-foreground truncate text-xs">@{a.username}</p>}
                  {a.status === "connected" && !a.autoRenews && a.tokenExpiresAt && <ExpiryNote iso={a.tokenExpiresAt} />}
                </div>
                {a.status !== "connected" ? (
                  <a
                    href={`/api/oauth/${platform}/start?reconnect=${a.id}`}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "border-amber-500/50 text-amber-600 dark:text-amber-400")}
                  >
                    <RefreshCw aria-hidden /> Reconnect
                  </a>
                ) : (
                  <Badge variant="secondary" className="bg-success/15 text-success">
                    Connected
                  </Badge>
                )}
                <Button variant="ghost" size="icon-sm" aria-label={`Disconnect ${a.username ?? meta.name}`} onClick={() => onRemove(a)}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {[...new Set(accounts.filter((a) => a.status === "connected" && a.capabilities.note).map((a) => a.capabilities.note!))].map((note) => (
          <p key={note} className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden /> {note}
          </p>
        ))}

        <div className="mt-auto">
          {implemented && configured ? (
            // A full navigation: the OAuth start route sets a cookie and redirects off-site.
            <a
              href={atLimit ? undefined : `/api/oauth/${platform}/start`}
              aria-disabled={atLimit}
              className={cn(
                buttonVariants({ variant: accounts.length ? "outline" : "brand" }),
                "h-9 w-full rounded-lg",
                atLimit && "pointer-events-none opacity-50",
              )}
            >
              <Plus aria-hidden /> {accounts.length ? "Add another account" : `Connect ${meta.name}`}
            </a>
          ) : (
            <Button variant="outline" className="h-9 w-full rounded-lg" disabled>
              {implemented ? "Not configured on this server" : "Coming soon"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const DAY_MS = 86_400_000;

/** For connections only the user can renew (LinkedIn): when to sign in again. */
function ExpiryNote({ iso }: { iso: string }) {
  const [now] = useState(() => Date.now());
  const days = Math.ceil((new Date(iso).getTime() - now) / DAY_MS);
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
  return (
    <p className={cn("text-xs", days <= 7 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
      Reconnect by {date}
      {days <= 7 ? ` · ${Math.max(days, 0)} ${days === 1 ? "day" : "days"} left` : ""}
    </p>
  );
}
