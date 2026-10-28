"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { groupByDay, MonthGrid, PostChip, TimeGrid } from "@/components/calendar/grids";
import { PageHeader } from "@/components/page-header";
import { PlatformGlyph } from "@/components/platform-icon";
import { PostDrawer } from "@/components/posts/post-drawer";
import { moveScheduledPost, postWhen, refreshPosts } from "@/components/posts/post-actions";
import { PostRow } from "@/components/posts/post-row";
import { STATUS_META } from "@/components/posts/status";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dropTarget, parseYmdKey, rangeFor, shiftAnchor, titleFor, ymdOf, type CalendarView as View, type Ymd } from "@/lib/calendar";
import { errorMessage, fetcher } from "@/lib/client/api";
import { useTimezone } from "@/lib/client/hooks";
import { useNow } from "@/lib/client/use-now";
import type { PostStatus } from "@/lib/constants";
import { PLATFORM_META } from "@/lib/platforms/meta";
import type { PostDTO } from "@/lib/posts-query";
import { formatInTz } from "@/lib/time";
import { cn } from "@/lib/utils";

interface PostsResponse {
  posts: PostDTO[];
  total: number;
}

export function CalendarView() {
  const { tz, ready } = useTimezone();
  if (!ready) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[32rem] rounded-2xl" />
      </div>
    );
  }
  return <CalendarInner tz={tz} />;
}

function CalendarInner({ tz }: { tz: string }) {
  const now = useNow(60_000);
  const today = ymdOf(now, tz);
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState<Ymd>(today);
  const [openId, setOpenId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const { from, to } = useMemo(() => rangeFor(view, anchor, tz), [view, anchor, tz]);
  const key = `/api/posts?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&pageSize=500&order=asc`;
  const { data, error, isLoading, mutate } = useSWR<PostsResponse>(key, fetcher, {
    // Posts flip from "publishing" to "published" on their own; keep the grid honest.
    refreshInterval: (d) => (d?.posts.some((p) => p.status === "publishing") ? 3000 : 0),
    keepPreviousData: true,
  });
  const posts = useMemo(() => data?.posts ?? [], [data]);
  const byDay = useMemo(() => groupByDay(posts, tz), [posts, tz]);
  const activePost = posts.find((p) => p.id === activeId) ?? null;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), // a plain click still opens the post
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const post = posts.find((p) => p.id === e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!post || !overId || post.status !== "scheduled" || !post.scheduledAt) return;

    let day: Ymd;
    let hour: number | null = null;
    if (overId.startsWith("day:")) {
      day = parseYmdKey(overId.slice(4));
    } else if (overId.startsWith("slot:")) {
      const [, dayKey, h] = overId.split(":");
      day = parseYmdKey(dayKey);
      hour = Number(h);
    } else return;

    const next = dropTarget(new Date(post.scheduledAt), day, hour, tz);
    if (next.getTime() === new Date(post.scheduledAt).getTime()) return;
    if (next.getTime() < Date.now() + 60_000) {
      toast.error("Pick a time at least a minute in the future.");
      return;
    }

    try {
      await mutate(
        async (current) => {
          await moveScheduledPost(post.id, next);
          return current;
        },
        {
          // Move it on screen immediately; roll back if the server says no.
          optimisticData: (current) => ({
            total: current?.total ?? 0,
            posts: (current?.posts ?? []).map((p) => (p.id === post.id ? { ...p, scheduledAt: next.toISOString() } : p)),
          }),
          rollbackOnError: true,
          populateCache: false,
          revalidate: true,
        },
      );
      toast.success(`Moved to ${formatInTz(next, tz)}`);
      void refreshPosts();
    } catch (err) {
      toast.error(errorMessage(err), { duration: 8000 });
    }
  }

  const monthHasPosts = view === "month" && posts.some((p) => postWhen(p));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <PageHeader
        title="Calendar"
        description={`Everything you've scheduled or published, in ${tz.replaceAll("_", " ")} time. Drag a scheduled post to move it.`}
        actions={
          <Link href="/dashboard/compose" className={cn(buttonVariants({ variant: "brand" }), "h-9 rounded-lg px-3")}>
            <Plus aria-hidden /> New post
          </Link>
        }
      />

      <Tabs defaultValue="calendar">
        <TabsList>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
          <TabsTrigger value="list">Post view</TabsTrigger>
        </TabsList>

        <TabsContent value="calendar" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" aria-label="Previous" onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))}>
                <ChevronLeft aria-hidden />
              </Button>
              <Button variant="outline" size="icon" aria-label="Next" onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))}>
                <ChevronRight aria-hidden />
              </Button>
              <Button variant="outline" onClick={() => setAnchor(today)}>
                Today
              </Button>
            </div>
            {/* On phones the title gets its own row; otherwise it is squeezed between the nav and the view switcher. */}
            <h2 className="order-last w-full min-w-0 text-lg font-semibold tracking-tight sm:order-none sm:w-auto sm:flex-1" aria-live="polite">
              {titleFor(view, anchor)}
            </h2>
            <div className="bg-muted ml-auto inline-flex rounded-lg p-0.5 sm:ml-0" role="group" aria-label="Calendar view">
              {(["month", "week", "day"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={cn("rounded-md px-3 py-1 text-sm font-medium capitalize transition-colors", view === v ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <Legend />

          {error && (
            <div role="alert" className="border-destructive/40 flex items-center gap-3 rounded-xl border p-3 text-sm">
              <span className="flex-1">{errorMessage(error)}</span>
              <Button variant="outline" size="sm" onClick={() => mutate()}>
                Retry
              </Button>
            </div>
          )}

          {isLoading && !data ? (
            <Skeleton className="h-[32rem] rounded-2xl" />
          ) : (
            <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))} onDragCancel={() => setActiveId(null)} onDragEnd={onDragEnd}>
              {view === "month" ? (
                <MonthGrid
                  anchor={anchor}
                  today={today}
                  byDay={byDay}
                  tz={tz}
                  onOpen={setOpenId}
                  onOpenDay={(d) => {
                    setAnchor(d);
                    setView("day");
                  }}
                />
              ) : (
                <TimeGrid view={view} anchor={anchor} today={today} byDay={byDay} tz={tz} onOpen={setOpenId} />
              )}
              <DragOverlay dropAnimation={null}>{activePost ? <PostChip post={activePost} tz={tz} overlay /> : null}</DragOverlay>
            </DndContext>
          )}

          {view === "month" && !isLoading && !monthHasPosts && (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarDays aria-hidden />
                </EmptyMedia>
                <EmptyTitle>Nothing on the calendar this month</EmptyTitle>
                <EmptyDescription>Schedule a post and it will show up here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </TabsContent>

        <TabsContent value="list">
          <PostGroups tz={tz} onOpen={setOpenId} />
        </TabsContent>
      </Tabs>

      <PostDrawer postId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function Legend() {
  return (
    <ul className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label="Legend">
      {(["twitter", "youtube"] as const).map((p) => (
        <li key={p} className="flex items-center gap-1.5">
          <span className="h-3 w-1 rounded-full" style={{ backgroundColor: p === "twitter" ? "var(--foreground)" : PLATFORM_META[p].color }} />
          <PlatformGlyph platform={p} className="size-3" /> {PLATFORM_META[p].name}
        </li>
      ))}
      <li className="ml-auto flex items-center gap-3">
        {(["scheduled", "published", "failed", "draft"] as const).map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cn("size-2 rounded-full", STATUS_META[s].dot)} /> {STATUS_META[s].label}
          </span>
        ))}
      </li>
    </ul>
  );
}

const GROUPS: { status: PostStatus; title: string; empty: string; order: "asc" | "desc" }[] = [
  { status: "scheduled", title: "Scheduled", empty: "Nothing scheduled.", order: "asc" },
  { status: "draft", title: "Drafts", empty: "No drafts.", order: "desc" },
  { status: "published", title: "Published", empty: "Nothing published yet.", order: "desc" },
  { status: "failed", title: "Failed", empty: "Nothing has failed.", order: "desc" },
];

/** The "Post view" tab: the same posts as a list, grouped by status. */
function PostGroups({ tz, onOpen }: { tz: string; onOpen: (id: string) => void }) {
  return (
    <div className="space-y-6">
      {GROUPS.map((g) => (
        <PostGroup key={g.status} group={g} tz={tz} onOpen={onOpen} />
      ))}
    </div>
  );
}

function PostGroup({ group, tz, onOpen }: { group: (typeof GROUPS)[number]; tz: string; onOpen: (id: string) => void }) {
  const { data, error, isLoading } = useSWR<PostsResponse>(`/api/posts?status=${group.status}&pageSize=6&order=${group.order}`, fetcher);
  return (
    <section className="space-y-2" aria-labelledby={`group-${group.status}`}>
      <div className="flex items-center justify-between">
        <h3 id={`group-${group.status}`} className="flex items-center gap-2 text-sm font-semibold">
          <span className={cn("size-2 rounded-full", STATUS_META[group.status].dot)} /> {group.title}
          {data && <span className="text-muted-foreground font-normal">({data.total})</span>}
        </h3>
        {data && data.total > data.posts.length && (
          <Link href={`/dashboard/posts?status=${group.status}`} className="text-primary text-xs font-medium underline-offset-4 hover:underline">
            View all
          </Link>
        )}
      </div>
      {error && <p className="text-destructive text-sm">{errorMessage(error)}</p>}
      {isLoading && <Skeleton className="h-14 rounded-xl" />}
      {data && data.posts.length === 0 && <p className="text-muted-foreground rounded-xl border border-dashed p-3 text-sm">{group.empty}</p>}
      {data && data.posts.length > 0 && (
        <ul className="space-y-2">
          {data.posts.map((p) => (
            <PostRow key={p.id} post={p} tz={tz} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}
