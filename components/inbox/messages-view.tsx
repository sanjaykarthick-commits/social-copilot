"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, ArrowUpRight, Info, Lock, MessagesSquare, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";
import { PlatformGlyph } from "@/components/platform-icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError, errorMessage, fetcher } from "@/lib/client/api";
import { useAccounts, useTimezone } from "@/lib/client/hooks";
import { useNow } from "@/lib/client/use-now";
import type { ConversationDTO, DirectMessageDTO, ThreadDTO } from "@/lib/messages";
import { formatInTz, timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { DM_TEXT_LIMIT, REPLY_WINDOW_CLOSED, replyWindow } from "@/lib/validation/messages";

/** Shared with the inbox's section switch (SWR dedupes the request). */
export const CONVERSATIONS_KEY = "/api/messages?pageSize=50";

export interface ConversationsResponse {
  conversations: ConversationDTO[];
  total: number;
  awaiting: number;
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const who = (c: ConversationDTO) => c.participant.name ?? (c.participant.handle ? `@${c.participant.handle}` : "Instagram user");

export function MessagesView() {
  const { tz } = useTimezone();
  const now = useNow(60_000);
  const [openId, setOpenId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { data: accountsData } = useAccounts();
  const { data, error, isLoading, mutate } = useSWR<ConversationsResponse>(CONVERSATIONS_KEY, fetcher, { refreshInterval: 60_000 });
  const { mutate: mutateThread } = useSWR<ThreadDTO>(openId ? `/api/messages/${openId}` : null, fetcher);

  async function sync(quiet = false) {
    setSyncing(true);
    try {
      const r = await api<{ added: number; synced: number; failed: { accountId: string; reason: string }[] }>("/api/messages/sync", { method: "POST" });
      await Promise.all([mutate(), mutateThread()]);
      if (!quiet) {
        if (r.failed.length) toast.error(`Could not read messages from ${r.failed.length === 1 ? "one account" : `${r.failed.length} accounts`}.`, { description: r.failed[0].reason, duration: 9000 });
        else if (r.synced === 0) toast("Already up to date.", { description: "Each account is checked at most once a minute." });
        else toast.success(r.added ? `${r.added} new ${r.added === 1 ? "message" : "messages"}.` : "No new messages.");
      }
    } catch (e) {
      if (!quiet) toast.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  // Check for new messages when the tab opens (the server skips accounts synced in the last minute).
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    void sync(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function open(id: string) {
    setOpenId(id);
    void sync(true); // fresh messages (and a fresh reply window) for the thread being opened
  }

  const accounts = accountsData?.accounts ?? [];
  const igAccounts = accounts.filter((a) => a.platform === "instagram");
  const limited = igAccounts.filter((a) => a.status === "connected" && !a.capabilities.messages);
  const list = data?.conversations ?? [];
  const current = list.find((c) => c.id === openId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground text-sm">Instagram direct messages. You can reply within 24 hours of someone&apos;s last message.</p>
        <Button variant="outline" className="h-9 shrink-0 rounded-lg" onClick={() => sync()} disabled={syncing}>
          <RefreshCw className={cn(syncing && "animate-spin")} aria-hidden /> {syncing ? "Checking…" : "Sync now"}
        </Button>
      </div>

      {limited.length > 0 && (
        <Card className="bg-muted/40">
          <CardContent className="space-y-2 text-sm">
            {limited.map((a) => (
              <p key={a.id} className="flex items-start gap-2">
                <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="flex-1">
                  <span className="font-medium">Instagram</span> ({a.username ? `@${a.username}` : (a.displayName ?? "account")}):{" "}
                  {a.capabilities.messagesNote ?? "messages are not available for this connection."}
                </span>
                <a href={`/api/oauth/instagram/start?reconnect=${a.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
                  Reconnect
                </a>
              </p>
            ))}
          </CardContent>
        </Card>
      )}

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
            <Skeleton key={i} className="h-16 rounded-2xl" />
          ))}
        </div>
      )}

      {data && list.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessagesSquare aria-hidden />
            </EmptyMedia>
            {accountsData && igAccounts.length === 0 ? (
              <>
                <EmptyTitle>Connect Instagram to see messages</EmptyTitle>
                <EmptyDescription>Direct messages to your Instagram professional account show up here, and you can answer them right away.</EmptyDescription>
              </>
            ) : (
              <>
                <EmptyTitle>No messages yet</EmptyTitle>
                <EmptyDescription>New messages arrive every 15 minutes, or press Sync now. Instagram doesn&apos;t let businesses start conversations, so threads appear once someone writes to you.</EmptyDescription>
              </>
            )}
          </EmptyHeader>
          {accountsData && igAccounts.length === 0 && (
            <EmptyContent>
              <Link href="/dashboard/accounts" className={cn(buttonVariants({ variant: "brand" }), "h-9 rounded-lg px-3")}>
                Connect accounts
              </Link>
            </EmptyContent>
          )}
        </Empty>
      )}

      {list.length > 0 && (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="grid lg:h-[clamp(440px,calc(100dvh-20rem),680px)] lg:grid-cols-[300px_minmax(0,1fr)]">
            <ul aria-label="Conversations" className={cn("divide-y overflow-y-auto lg:border-r", current && "hidden lg:block")}>
              {list.map((c) => (
                <li key={c.id}>
                  <ConversationRow conversation={c} active={c.id === openId} now={now} tz={tz} onOpen={() => open(c.id)} />
                </li>
              ))}
            </ul>
            <div className={cn("min-h-0", !current && "hidden lg:flex lg:items-center lg:justify-center")}>
              {current ? (
                <Thread key={current.id} summary={current} now={now} tz={tz} onBack={() => setOpenId(null)} onChange={() => mutate()} />
              ) : (
                <p className="text-muted-foreground p-6 text-center text-sm">Choose a conversation to read it and reply.</p>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function ConversationRow({ conversation: c, active, now, tz, onOpen }: { conversation: ConversationDTO; active: boolean; now: Date; tz: string; onOpen: () => void }) {
  const name = who(c);
  const preview = c.lastMessage.text ? c.lastMessage.text : "Sent an attachment";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active || undefined}
      className={cn("hover:bg-muted/60 flex w-full items-start gap-3 p-3 text-left transition-colors", active && "bg-muted")}
    >
      <Avatar className="size-9">
        {c.participant.imageUrl && <AvatarImage src={c.participant.imageUrl} alt="" />}
        <AvatarFallback>{name.replace(/^@/, "").slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-sm", c.awaitingReply ? "font-semibold" : "font-medium")}>{name}</span>
          {c.lastMessage.at && (
            <time className="text-muted-foreground ml-auto shrink-0 text-xs" dateTime={c.lastMessage.at}>
              {timeAgo(new Date(c.lastMessage.at), now, tz)}
            </time>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-xs", c.awaitingReply ? "text-foreground" : "text-muted-foreground")}>
            {c.lastMessage.fromMe && "You: "}
            {preview}
          </span>
          {c.awaitingReply && (
            <span className="bg-primary ml-auto size-2 shrink-0 rounded-full">
              <span className="sr-only">Waiting for your reply</span>
            </span>
          )}
        </span>
        <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
          <PlatformGlyph platform={c.platform} className="size-2.5" />
          <span className="truncate">to {c.account.label}</span>
        </span>
      </span>
    </button>
  );
}

function Thread({ summary, now, tz, onBack, onChange }: { summary: ConversationDTO; now: Date; tz: string; onBack: () => void; onChange: () => void }) {
  const { data, error, mutate } = useSWR<ThreadDTO>(`/api/messages/${summary.id}`, fetcher, { refreshInterval: 30_000 });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // One key per draft: a double click (or a retried request) reuses it, so the server sends once.
  const keyRef = useRef(newKey());
  const sendingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversation = data?.conversation ?? summary;
  const messages = data?.messages ?? [];
  const replyWin = replyWindow(conversation.lastInboundAt, now);
  const name = who(conversation);
  const trimmed = text.trim();
  const tooLong = trimmed.length > DM_TEXT_LIMIT;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function send(body: string, key: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const r = await api<ThreadDTO>(`/api/messages/${summary.id}/reply`, { method: "POST", json: { text: body, idempotencyKey: key } });
      await mutate(r, { revalidate: false });
      if (body === trimmed) setText("");
      toast.success("Message sent.");
    } catch (e) {
      toast.error("The message was not sent.", { description: errorMessage(e), duration: 9000 });
      const thread = e instanceof ApiClientError ? (e.details as { thread?: ThreadDTO } | undefined)?.thread : undefined;
      if (thread) await mutate(thread, { revalidate: false });
      else if (e instanceof ApiClientError && e.code === "REPLY_WINDOW_CLOSED") await mutate();
    } finally {
      keyRef.current = newKey(); // the next attempt is a new message
      sendingRef.current = false;
      setSending(false);
      onChange();
    }
  }

  const submit = () => {
    if (!trimmed || tooLong || !replyWin.open) return;
    void send(trimmed, keyRef.current);
  };

  return (
    <div className="flex h-full min-h-[420px] flex-col lg:min-h-0">
      <div className="flex items-center gap-2 border-b p-3">
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Back to conversations" onClick={onBack}>
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-muted-foreground flex items-center gap-1 text-xs">
            <PlatformGlyph platform={conversation.platform} className="size-3" />
            <span className="truncate">to {conversation.account.label}</span>
          </p>
        </div>
        {conversation.participant.handle && (
          <a
            href={`https://www.instagram.com/${encodeURIComponent(conversation.participant.handle)}/`}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0")}
          >
            Profile <ArrowUpRight aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite">
        {error && !data && <p className="text-destructive text-sm">{errorMessage(error)}</p>}
        {!data && !error && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className={cn("h-10 w-2/3 rounded-2xl", i % 2 && "ml-auto")} />)}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} now={now} tz={tz} disabled={sending || !replyWin.open} onRetry={() => void send(m.text, newKey())} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t p-3">
        {replyWin.open ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                keyRef.current = newKey(); // edited text is a different message
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={`Message ${name}…`}
              aria-label={`Message ${name}`}
              aria-invalid={tooLong}
              className="min-h-16"
              disabled={sending}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                <span className={cn("tabular-nums", tooLong && "text-destructive")}>
                  {trimmed.length.toLocaleString()} / {DM_TEXT_LIMIT.toLocaleString()}
                </span>
                {replyWin.endsAt && <span> · You can reply until {formatInTz(replyWin.endsAt, tz)}</span>}
                <span className="ml-2 hidden sm:inline">
                  <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> to send
                </span>
              </span>
              <Button type="submit" variant="brand" size="sm" disabled={sending || !trimmed || tooLong}>
                <Send aria-hidden /> {sending ? "Sending…" : "Send"}
              </Button>
            </div>
          </form>
        ) : (
          <p className="bg-muted/50 text-muted-foreground flex items-start gap-2 rounded-xl p-3 text-sm" role="note">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {REPLY_WINDOW_CLOSED}{" "}
              <a href="https://www.instagram.com/direct/inbox/" target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
                Open Instagram
              </a>{" "}
              to answer there.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message: m, now, tz, disabled, onRetry }: { message: DirectMessageDTO; now: Date; tz: string; disabled: boolean; onRetry: () => void }) {
  const mine = m.direction === "outbound";
  return (
    <div className={cn("flex flex-col gap-0.5", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap",
          mine ? "bg-primary text-primary-foreground" : "bg-muted",
          m.status === "failed" && "bg-destructive/10 text-foreground",
          m.status === "sending" && "opacity-70",
        )}
      >
        {m.text || <span className="italic opacity-80">Sent an attachment. Open Instagram to see it.</span>}
      </div>
      <p className="text-muted-foreground text-[11px]">
        {m.status === "sending" ? "Sending…" : m.status === "failed" ? "Not sent" : timeAgo(new Date(m.sentAt), now, tz)}
      </p>
      {m.status === "failed" && (
        <p className="text-destructive flex flex-wrap items-center justify-end gap-2 text-xs">
          <span>{m.error}</span>
          <Button variant="outline" size="xs" disabled={disabled} onClick={onRetry}>
            Try again
          </Button>
        </p>
      )}
    </div>
  );
}
