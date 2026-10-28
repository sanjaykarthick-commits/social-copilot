"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { AlertCircle, AlertTriangle, ArrowUpRight, CalendarClock, CheckCircle2, ExternalLink, Eye, Heart, Layers, MessageCircle, Plus, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PlatformGlyph } from "@/components/platform-icon";
import { PostDrawer } from "@/components/posts/post-drawer";
import { PostRow } from "@/components/posts/post-row";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicAccount } from "@/lib/accounts";
import type { AnalyticsData } from "@/lib/analytics";
import type { CommentDTO } from "@/lib/comments";
import { errorMessage, fetcher } from "@/lib/client/api";
import { useAccounts, useSettings, useTimezone } from "@/lib/client/hooks";
import { useNow } from "@/lib/client/use-now";
import { PLATFORM_META } from "@/lib/platforms/meta";
import { formatInTz, timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

const RANGE_OPTIONS = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

const chartConfig = {
  published: { label: "Published", color: "var(--success)" },
  scheduled: { label: "Scheduled", color: "var(--primary)" },
  failed: { label: "Failed", color: "var(--destructive)" },
} satisfies ChartConfig;

const nf = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function DashboardView() {
  const [days, setDays] = useState(30);
  const [openId, setOpenId] = useState<string | null>(null);
  const { tz } = useTimezone();
  const { data: settings } = useSettings();
  const { data: accounts } = useAccounts();
  const { data, error, isLoading, mutate } = useSWR<AnalyticsData>(`/api/analytics?range=${days}`, fetcher, {
    keepPreviousData: true,
    refreshInterval: (d) => (d && d.totals.publishing > 0 ? 3000 : 0),
  });

  const { data: inbox } = useSWR<{ comments: CommentDTO[]; counts: { open: number } }>("/api/comments?status=open&pageSize=3", fetcher);
  const now = useNow(60_000);

  const first = settings?.name?.split(" ")[0];
  const noAccounts = accounts && accounts.accounts.length === 0;
  const attention = (accounts?.accounts ?? []).filter((a) => needsAttention(a, now));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title={first ? `Welcome back, ${first}` : "Dashboard"}
        description="What you've published, what's coming up, and what needs attention."
        actions={
          <>
            <NativeSelect aria-label="Date range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="[&>select]:h-9">
              {RANGE_OPTIONS.map((r) => (
                <NativeSelectOption key={r.value} value={r.value}>
                  {r.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Link href="/dashboard/compose" className={cn(buttonVariants({ variant: "brand" }), "h-9 rounded-lg px-3")}>
              <Plus aria-hidden /> New post
            </Link>
          </>
        }
      />

      {noAccounts && (
        <Card className="border-primary/30 bg-accent/40">
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Connect your first account</p>
              <p className="text-muted-foreground text-sm">Link Instagram, YouTube or LinkedIn, then schedule a post. It takes about a minute.</p>
            </div>
            <Link href="/dashboard/accounts" className={cn(buttonVariants({ variant: "brand" }), "h-9 rounded-lg px-3")}>
              Connect an account <ArrowUpRight aria-hidden />
            </Link>
          </CardContent>
        </Card>
      )}

      {attention.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5" role="status">
          <CardContent className="space-y-2">
            {attention.map((a) => (
              <div key={a.id} className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center">
                <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                <span className="flex-1">
                  <span className="font-medium">
                    {PLATFORM_META[a.platform].name} {a.username ? `@${a.username}` : (a.displayName ?? "")}
                  </span>{" "}
                  {a.status !== "connected"
                    ? "is disconnected. Scheduled posts to it will fail until you reconnect."
                    : `stops working ${expiresIn(a.tokenExpiresAt!, now)} (${formatInTz(new Date(a.tokenExpiresAt!), tz, { dateStyle: "medium" })}). ${PLATFORM_META[a.platform].name} asks you to sign in again every 60 days.`}
                </span>
                <a href={`/api/oauth/${a.platform}/start?reconnect=${a.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
                  <RefreshCw aria-hidden /> Reconnect
                </a>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {error && !data && (
        <div role="alert" className="border-destructive/40 flex items-center gap-3 rounded-xl border p-3 text-sm">
          <AlertCircle className="text-destructive size-4 shrink-0" aria-hidden />
          <span className="flex-1">{errorMessage(error)}</span>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            Retry
          </Button>
        </div>
      )}

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Layers} label="Total posts" value={data?.totals.total} loading={isLoading && !data} hint="incl. upcoming" />
        <Stat icon={CheckCircle2} label="Published" value={data?.totals.published} loading={isLoading && !data} tone="success" />
        <Stat icon={CalendarClock} label="Scheduled" value={data ? data.totals.scheduled + data.totals.publishing : undefined} loading={isLoading && !data} tone="primary" />
        <Stat icon={AlertCircle} label="Failed" value={data?.totals.failed} loading={isLoading && !data} tone="destructive" />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Posts over time</CardTitle>
            <CardDescription>By day in {tz.replaceAll("_", " ")}. The last week shows what&apos;s scheduled.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading && !data ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : data && data.totals.total === 0 ? (
              <EmptyChart />
            ) : data ? (
              <ChartContainer config={chartConfig} className="h-64 w-full">
                <BarChart data={data.daily} margin={{ left: -16, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={28}
                    tickFormatter={(v: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${v}T00:00:00Z`))}
                  />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} domain={[0, (max: number) => Math.max(2, max)]} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(v) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${v}T00:00:00Z`))}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="published" stackId="a" fill="var(--color-published)" animationDuration={400} />
                  <Bar dataKey="scheduled" stackId="a" fill="var(--color-scheduled)" animationDuration={400} />
                  <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" radius={[4, 4, 0, 0]} animationDuration={400} />
                </BarChart>
              </ChartContainer>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By platform</CardTitle>
            <CardDescription>Posts sent to each platform.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading && !data ? <Skeleton className="h-40 rounded-xl" /> : <PlatformSplit data={data} />}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <PostListCard title="Up next" description="Scheduled, soonest first." posts={data?.upcoming} loading={isLoading && !data} tz={tz} onOpen={setOpenId} empty="Nothing scheduled. Schedule a post and it will show up here." href="/dashboard/calendar" linkLabel="Open calendar" />
        <PostListCard title="Recent posts" description="What went out, newest first." posts={data?.recent} loading={isLoading && !data} tz={tz} onOpen={setOpenId} empty="Nothing published yet." href="/dashboard/posts" linkLabel="View all" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Engagement</CardTitle>
            <CardDescription>Likes, comments and views reported by the platforms.</CardDescription>
          </CardHeader>
          <CardContent>{isLoading && !data ? <Skeleton className="h-32 rounded-xl" /> : <Engagement data={data} tz={tz} />}</CardContent>
        </Card>
        <NeedsReply data={inbox} now={now} tz={tz} />
      </div>

      <PostDrawer postId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

const DAY_MS = 86_400_000;

/** Disconnected, or a connection the platform will not let us renew (LinkedIn) that ends within a week. */
function needsAttention(a: PublicAccount, now: Date) {
  if (a.status !== "connected") return true;
  return !a.autoRenews && a.tokenExpiresAt !== null && new Date(a.tokenExpiresAt).getTime() - now.getTime() < 7 * DAY_MS;
}

function expiresIn(iso: string, now: Date) {
  const days = Math.ceil((new Date(iso).getTime() - now.getTime()) / DAY_MS);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

function NeedsReply({ data, now, tz }: { data: { comments: CommentDTO[]; counts: { open: number } } | undefined; now: Date; tz: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Needs reply
          {data && data.counts.open > 0 && <span className="bg-primary text-primary-foreground rounded-full px-2 text-xs leading-5 tabular-nums">{data.counts.open}</span>}
        </CardTitle>
        <CardDescription>Comments on your posts.</CardDescription>
        <CardAction>
          <Link href="/dashboard/inbox" className="text-primary text-sm font-medium underline-offset-4 hover:underline">
            Open inbox
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : data.comments.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">No comments waiting for a reply.</p>
        ) : (
          <ul className="space-y-3">
            {data.comments.map((c) => (
              <li key={c.id}>
                <Link href="/dashboard/inbox" className="hover:bg-muted/60 -mx-2 block rounded-lg px-2 py-1.5">
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <PlatformGlyph platform={c.platform} className="size-3" />
                    <span className="truncate">{c.authorName ?? (c.authorHandle ? `@${c.authorHandle}` : "Someone")}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{timeAgo(new Date(c.commentedAt), now, tz)}</span>
                  </p>
                  <p className="line-clamp-2 text-sm">{c.text}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const TONES = {
  default: "bg-muted text-muted-foreground",
  success: "bg-success/15 text-success",
  primary: "bg-primary/10 text-primary",
  destructive: "bg-destructive/10 text-destructive",
} as const;

function Stat({
  icon: Icon,
  label,
  value,
  loading,
  tone = "default",
  hint,
}: {
  icon: typeof Layers;
  label: string;
  value: number | undefined;
  loading: boolean;
  tone?: keyof typeof TONES;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", TONES[tone])}>
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-muted-foreground truncate text-xs">
            {label}
            {hint && <span className="text-muted-foreground/70"> · {hint}</span>}
          </p>
          {loading || value === undefined ? <Skeleton className="mt-1 h-7 w-12" /> : <p className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function PostListCard({
  title,
  description,
  posts,
  loading,
  tz,
  onOpen,
  empty,
  href,
  linkLabel,
}: {
  title: string;
  description: string;
  posts: AnalyticsData["recent"] | undefined;
  loading: boolean;
  tz: string;
  onOpen: (id: string) => void;
  empty: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Link href={href} className="text-primary text-sm font-medium underline-offset-4 hover:underline">
            {linkLabel}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : posts && posts.length > 0 ? (
          <ul className="space-y-2">
            {posts.map((p) => (
              <PostRow key={p.id} post={p} tz={tz} onOpen={onOpen} />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyChart() {
  return (
    <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-sm">
      <p>No posts in this period yet.</p>
      <Link href="/dashboard/compose" className={cn(buttonVariants({ variant: "outline" }), "h-8 rounded-lg px-3")}>
        Schedule your first post
      </Link>
    </div>
  );
}

function PlatformSplit({ data }: { data: AnalyticsData | undefined }) {
  if (!data || data.platforms.length === 0) {
    return <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">No platform activity in this period.</p>;
  }
  const max = Math.max(...data.platforms.map((p) => p.total));
  return (
    <ul className="space-y-4">
      {data.platforms.map((p) => {
        const meta = PLATFORM_META[p.platform];
        return (
          <li key={p.platform} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <PlatformGlyph platform={p.platform} className="size-4" /> {meta.name}
              </span>
              <span className="text-muted-foreground tabular-nums">{p.total}</span>
            </div>
            <div
              className="bg-muted flex h-2 overflow-hidden rounded-full"
              role="img"
              aria-label={`${meta.name}: ${p.published} published, ${p.scheduled} scheduled, ${p.failed} failed`}
              style={{ width: `${Math.max((p.total / max) * 100, 8)}%` }}
            >
              <span className="bg-success" style={{ width: `${(p.published / p.total) * 100}%` }} />
              <span className="bg-primary" style={{ width: `${(p.scheduled / p.total) * 100}%` }} />
              <span className="bg-destructive" style={{ width: `${(p.failed / p.total) * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Engagement({ data, tz }: { data: AnalyticsData | undefined; tz: string }) {
  if (!data || !data.engagement.available) {
    return (
      <div className="text-muted-foreground space-y-1 rounded-xl border border-dashed p-5 text-center text-sm">
        <p className="text-foreground font-medium">Not available yet</p>
        <p>Numbers appear after a post has been published and the platform has reported them. They refresh every few hours. LinkedIn shares stats only with apps it has approved.</p>
      </div>
    );
  }
  const e = data.engagement;
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-3">
        {[
          { icon: Heart, label: "Likes", v: e.likes },
          { icon: MessageCircle, label: "Comments", v: e.comments },
          { icon: Eye, label: "Views", v: e.impressions },
        ].map(({ icon: Icon, label, v }) => (
          <div key={label} className="bg-muted/50 rounded-xl p-3">
            <dt className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Icon className="size-3.5" aria-hidden /> {label}
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{nf.format(v)}</dd>
          </div>
        ))}
      </dl>
      {e.byPlatform.length > 1 && (
        <div className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">By platform</h3>
          <table className="w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th>Platform</th>
                <th>Likes</th>
                <th>Comments</th>
                <th>Views</th>
              </tr>
            </thead>
            <tbody>
              {e.byPlatform.map((p) => (
                <tr key={p.platform} className="border-b last:border-0">
                  <th scope="row" className="py-1.5 text-left font-medium">
                    <span className="flex items-center gap-2">
                      <PlatformGlyph platform={p.platform} className="size-3.5" /> {PLATFORM_META[p.platform].name}
                    </span>
                  </th>
                  <td className="text-muted-foreground py-1.5 text-right tabular-nums">
                    {nf.format(p.likes)} <Heart className="inline size-3" aria-label="likes" />
                  </td>
                  <td className="text-muted-foreground py-1.5 text-right tabular-nums">
                    {nf.format(p.comments)} <MessageCircle className="inline size-3" aria-label="comments" />
                  </td>
                  <td className="text-muted-foreground py-1.5 text-right tabular-nums">
                    {p.impressionsKnown ? nf.format(p.impressions) : "–"} <Eye className="inline size-3" aria-label="views" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {e.top.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Top posts</h3>
          <ul className="space-y-1.5">
            {e.top.slice(0, 3).map((t) => (
              <li key={t.targetId} className="flex items-center gap-2 text-sm">
                <PlatformGlyph platform={t.platform} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t.content.trim() || "Media post"}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {nf.format(t.likes)} <Heart className="inline size-3" aria-label="likes" />
                </span>
                {t.url && (
                  <a href={t.url} target="_blank" rel="noreferrer" aria-label="Open post" className="text-muted-foreground hover:text-foreground">
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {e.updatedAt && <p className="text-muted-foreground text-xs">Updated {formatInTz(new Date(e.updatedAt), tz)}</p>}
    </div>
  );
}
