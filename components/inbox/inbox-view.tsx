"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Archive, ArrowUpRight, ChevronLeft, ChevronRight, Inbox, Info, MessageCircle, RefreshCw, Reply, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { PlatformGlyph } from "@/components/platform-icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { CommentDTO } from "@/lib/comments";
import type { Platform } from "@/lib/constants";
import { api, ApiClientError, errorMessage, fetcher } from "@/lib/client/api";
import { useAccounts, useTimezone } from "@/lib/client/hooks";
import { useNow } from "@/lib/client/use-now";
import { PLATFORM_META } from "@/lib/platforms/meta";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { replyLimit } from "@/lib/validation/comments";

const PAGE_SIZE = 20;
const COMMENT_PLATFORMS: Platform[] = ["instagram", "youtube", "linkedin"];
const TABS = [
  { value: "open", label: "Needs reply" },
  { value: "replied", label: "Replied" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
] as const;
type Tab = (typeof TABS)[number]["value"];

interface CommentsResponse {
  comments: CommentDTO[];
  total: number;
  counts: { open: number; replied: number; archived: number };
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const POST_NOUN: Partial<Record<Platform, string>> = { youtube: "YouTube video", instagram: "Instagram post", linkedin: "LinkedIn post" };

export function InboxView() {
  const { tz } = useTimezone();
  const now = useNow(60_000);
  const [tab, setTab] = useState<Tab>("open");
  const [platform, setPlatform] = useState("");
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const { data: accountsData } = useAccounts();

  const params = new URLSearchParams({ status: tab, page: String(page), pageSize: String(PAGE_SIZE) });
  if (platform) params.set("platform", platform);
  const { data, error, isLoading, mutate } = useSWR<CommentsResponse>(`/api/comments?${params}`, fetcher, { keepPreviousData: true });

  async function sync(quiet = false) {
    setSyncing(true);
    try {
      const r = await api<{ added: number; synced: number; failed: { accountId: string; reason: string }[] }>("/api/comments/sync", { method: "POST" });
      await mutate();
      if (!quiet) {
        if (r.failed.length) toast.error(`Could not read comments from ${r.failed.length === 1 ? "one account" : `${r.failed.length} accounts`}.`, { description: r.failed[0].reason, duration: 9000 });
        else if (r.synced === 0) toast("Already up to date.", { description: "Each account is checked at most once a minute." });
        else toast.success(r.added ? `${r.added} new ${r.added === 1 ? "comment" : "comments"}.` : "No new comments.");
      }
    } catch (e) {
      if (!quiet) toast.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  // Check for new comments when the inbox opens (the server skips accounts synced in the last minute).
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    void sync(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accounts = accountsData?.accounts ?? [];
  const commentAccounts = accounts.filter((a) => COMMENT_PLATFORMS.includes(a.platform));
  const limited = commentAccounts.filter((a) => a.status === "connected" && !a.capabilities.comments);
  const counts = data?.counts;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const replace = (c: CommentDTO) =>
    mutate(
      (d) =>
        d && {
          ...d,
          // A comment that left the current tab disappears from it; the counts catch up on revalidation.
          comments: d.comments.flatMap((x) => (x.id !== c.id ? [x] : tab === "all" || c.status === tab ? [c] : [])),
        },
      { revalidate: true },
    );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader
        title="Inbox"
        description="Comments on your Instagram, YouTube and LinkedIn posts. Reply without leaving Social Copilot."
        actions={
          <Button variant="outline" className="h-9 rounded-lg" onClick={() => sync()} disabled={syncing}>
            <RefreshCw className={cn(syncing && "animate-spin")} aria-hidden /> {syncing ? "Checking…" : "Sync now"}
          </Button>
        }
      />

      {limited.length > 0 && (
        <Card className="bg-muted/40">
          <CardContent className="space-y-2 text-sm">
            {limited.map((a) => (
              <p key={a.id} className="flex items-start gap-2">
                <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="flex-1">
                  <span className="font-medium">{PLATFORM_META[a.platform].name}</span> ({a.username ? `@${a.username}` : (a.displayName ?? "account")}): {a.capabilities.note ?? "comments are not available for this connection."}
                </span>
                {a.platform !== "linkedin" && (
                  <a href={`/api/oauth/${a.platform}/start?reconnect=${a.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
                    Reconnect
                  </a>
                )}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as Tab);
            setPage(1);
          }}
        >
          <TabsList className="grid w-full grid-cols-2 group-data-horizontal/tabs:h-auto sm:flex sm:w-fit">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="gap-1.5 px-3 py-1">
                {t.label}
                {t.value !== "all" && counts && counts[t.value] > 0 && (
                  <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", t.value === "open" ? "bg-primary text-primary-foreground" : "bg-muted-foreground/15")}>
                    {counts[t.value]}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <NativeSelect
          aria-label="Filter by platform"
          value={platform}
          onChange={(e) => {
            setPlatform(e.target.value);
            setPage(1);
          }}
        >
          <NativeSelectOption value="">All platforms</NativeSelectOption>
          {COMMENT_PLATFORMS.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {PLATFORM_META[p].name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {error && (
        <div role="alert" className="border-destructive/40 flex items-center gap-3 rounded-xl border p-3 text-sm">
          <span className="flex-1">{errorMessage(error)}</span>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            Retry
          </Button>
        </div>
      )}

      {isLoading && !data && (
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      )}

      {data && data.comments.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox aria-hidden />
            </EmptyMedia>
            {accountsData && commentAccounts.length === 0 ? (
              <>
                <EmptyTitle>Connect an account to see comments</EmptyTitle>
                <EmptyDescription>Comments from Instagram, YouTube and LinkedIn show up here, and you can reply right away.</EmptyDescription>
              </>
            ) : tab === "open" && !platform ? (
              <>
                <EmptyTitle>You&apos;re all caught up</EmptyTitle>
                <EmptyDescription>New comments arrive every 15 minutes, or press Sync now.</EmptyDescription>
              </>
            ) : (
              <>
                <EmptyTitle>Nothing here</EmptyTitle>
                <EmptyDescription>No comments match this view.</EmptyDescription>
              </>
            )}
          </EmptyHeader>
          {accountsData && commentAccounts.length === 0 && (
            <EmptyContent>
              <Link href="/dashboard/accounts" className={cn(buttonVariants({ variant: "brand" }), "h-9 rounded-lg px-3")}>
                Connect accounts
              </Link>
            </EmptyContent>
          )}
        </Empty>
      )}

      {data && data.comments.length > 0 && (
        <>
          <ul className="space-y-3">
            {data.comments.map((c) => (
              <CommentCard key={c.id} comment={c} now={now} tz={tz} onChange={replace} />
            ))}
          </ul>
          {pages > 1 && (
            <div className="text-muted-foreground flex items-center justify-between text-sm">
              <span>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft aria-hidden />
                </Button>
                <span className="px-2 tabular-nums">
                  {page} / {pages}
                </span>
                <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight aria-hidden />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CommentCard({ comment: c, now, tz, onChange }: { comment: CommentDTO; now: Date; tz: string; onChange: (c: CommentDTO) => void }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const limit = replyLimit(c.platform);
  const author = c.authorName ?? (c.authorHandle ? `@${c.authorHandle}` : c.platform === "linkedin" ? "LinkedIn member" : "Someone");
  const sub = c.authorName && c.authorHandle && c.authorHandle !== c.authorName ? `@${c.authorHandle}` : null;
  const when = new Date(c.commentedAt);

  async function send(body = text) {
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > limit) return;
    setSending(true);
    try {
      const r = await api<{ comment: CommentDTO }>(`/api/comments/${c.id}/reply`, { method: "POST", json: { text: trimmed, idempotencyKey: newKey() } });
      toast.success("Reply sent.");
      setText("");
      setReplying(false);
      onChange(r.comment);
    } catch (e) {
      toast.error("The reply was not sent.", { description: errorMessage(e), duration: 9000 });
      const updated = e instanceof ApiClientError ? (e.details as { comment?: CommentDTO } | undefined)?.comment : undefined;
      if (updated) onChange(updated);
    } finally {
      setSending(false);
    }
  }

  async function setStatus(status: "open" | "archived") {
    setBusy(true);
    try {
      const r = await api<{ comment: CommentDTO }>(`/api/comments/${c.id}`, { method: "PATCH", json: { status } });
      onChange(r.comment);
      toast.success(status === "archived" ? "Archived." : "Moved back to the inbox.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <Card className="gap-0 py-0">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <Avatar className="size-9">
              {c.authorImageUrl && <AvatarImage src={c.authorImageUrl} alt="" />}
              <AvatarFallback>{author.replace(/^@/, "").slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
                <span className="font-medium">{author}</span>
                {sub && <span className="text-muted-foreground">{sub}</span>}
                <span className="text-muted-foreground" aria-hidden>
                  ·
                </span>
                <time className="text-muted-foreground" dateTime={c.commentedAt} title={when.toLocaleString()}>
                  {timeAgo(when, now, tz)}
                </time>
              </div>
              <p className="text-muted-foreground flex items-center gap-1 text-xs">
                <PlatformGlyph platform={c.platform} className="size-3" />
                <span className="truncate">on {c.account.label}</span>
              </p>
            </div>
            {c.status === "replied" && <span className="bg-success/15 text-success shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">Replied</span>}
            {c.status === "archived" && <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">Archived</span>}
          </div>

          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{c.text || <span className="text-muted-foreground italic">(no text)</span>}</p>

          {(c.post.url || c.post.title) && (
            <a
              href={c.post.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="bg-muted/50 hover:bg-muted flex items-center gap-3 rounded-xl p-2 text-xs transition-colors"
            >
              {c.post.thumbnailUrl ? (
                // Platform CDN thumbnails: plain <img>, they are tiny and already sized.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.post.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="bg-background flex size-10 shrink-0 items-center justify-center rounded-lg">
                  <PlatformGlyph platform={c.platform} className="size-4" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.post.title ?? POST_NOUN[c.platform] ?? "Post"}</span>
                <span className="text-muted-foreground">{c.post.fromSocialCopilot ? "Published with Social Copilot" : POST_NOUN[c.platform]}</span>
              </span>
              <ArrowUpRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}

          {c.replies.length > 0 && (
            <ul className="border-primary/30 space-y-2 border-l-2 pl-3">
              {c.replies.map((r) => (
                <li key={r.id} className="text-sm">
                  <p className="text-muted-foreground text-xs">
                    {r.status === "sent" ? "You replied" : r.status === "failed" ? "Not sent" : "Sending…"} · {timeAgo(new Date(r.createdAt), now, tz)}
                  </p>
                  <p className="break-words whitespace-pre-wrap">{r.text}</p>
                  {r.status === "failed" && (
                    <p className="text-destructive mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span>{r.error}</span>
                      <Button variant="outline" size="xs" disabled={sending} onClick={() => send(r.text)}>
                        Try again
                      </Button>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {replying ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <Textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                  if (e.key === "Escape") setReplying(false);
                }}
                placeholder={`Reply to ${author}…`}
                aria-label={`Reply to ${author}`}
                aria-invalid={text.length > limit}
                className="min-h-20"
                disabled={sending}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={cn("text-xs tabular-nums", text.length > limit ? "text-destructive" : "text-muted-foreground")}>
                  {text.length.toLocaleString()} / {limit.toLocaleString()}
                  <span className="ml-2 hidden sm:inline">
                    <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> to send
                  </span>
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReplying(false)} disabled={sending}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="brand" size="sm" disabled={sending || !text.trim() || text.length > limit}>
                    <Reply aria-hidden /> {sending ? "Sending…" : "Send reply"}
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant={c.status === "open" ? "brand" : "outline"} size="sm" onClick={() => setReplying(true)}>
                <MessageCircle aria-hidden /> Reply
              </Button>
              {c.status === "archived" ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStatus("open")}>
                  <Undo2 aria-hidden /> Move to inbox
                </Button>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStatus("archived")}>
                  <Archive aria-hidden /> {c.status === "open" ? "No reply needed" : "Archive"}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}
