"use client";

import { useEffect, useRef } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { PlatformGlyph } from "@/components/platform-icon";
import { postWhen } from "@/components/posts/post-actions";
import { sameDay, sameMonth, visibleDays, weekDays, ymdKey, ymdOf, type CalendarView, type Ymd } from "@/lib/calendar";
import { PLATFORM_META } from "@/lib/platforms/meta";
import type { PostDTO } from "@/lib/posts-query";
import { fromInstant } from "@/lib/time";
import { cn } from "@/lib/utils";

/** X and Threads are near-black; use the theme foreground so their chips stay visible in dark mode. */
const chipColor = (post: PostDTO) => {
  const p = post.targets[0]?.platform;
  if (!p) return "var(--muted-foreground)";
  return p === "twitter" || p === "threads" ? "var(--foreground)" : PLATFORM_META[p].color;
};

const clock = (d: Date, tz: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);

export function groupByDay(posts: PostDTO[], tz: string): Map<string, PostDTO[]> {
  const map = new Map<string, PostDTO[]>();
  for (const p of posts) {
    const when = postWhen(p);
    if (!when) continue;
    const key = ymdKey(ymdOf(when, tz));
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }
  for (const list of map.values()) list.sort((a, b) => (postWhen(a)!.getTime() - postWhen(b)!.getTime()));
  return map;
}

const STATUS_ICON = {
  scheduled: <Clock className="size-3" aria-hidden />,
  publishing: <Loader2 className="size-3 animate-spin" aria-hidden />,
  published: <CheckCircle2 className="size-3" aria-hidden />,
  failed: <AlertCircle className="size-3" aria-hidden />,
  draft: null,
} as const;

/** A post on the grid. Only scheduled posts can be dragged. */
export function PostChip({ post, tz, onOpen, overlay = false }: { post: PostDTO; tz: string; onOpen?: (id: string) => void; overlay?: boolean }) {
  const draggable = post.status === "scheduled" && !overlay;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: post.id, disabled: !draggable });
  const when = postWhen(post);
  const platforms = [...new Set(post.targets.map((t) => t.platform))];
  const text = post.content.trim() || (post.media.length ? "Media post" : "No text");

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
      onClick={() => onOpen?.(post.id)}
      title={`${text}${draggable ? " (drag to reschedule)" : ""}`}
      aria-label={`${text}, ${post.status}${when ? ` at ${clock(when, tz)}` : ""}`}
      style={{ "--chip": chipColor(post) } as React.CSSProperties}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md border-l-[3px] border-l-(--chip) bg-[color-mix(in_oklch,var(--chip)_10%,var(--card))] px-1.5 py-1 text-left text-[11px] leading-tight shadow-xs outline-none",
        "focus-visible:ring-ring/50 focus-visible:ring-2",
        draggable && "cursor-grab touch-none active:cursor-grabbing",
        post.status === "draft" && "border-dashed border-y border-r border-y-border border-r-border",
        post.status === "failed" && "ring-destructive/40 ring-1",
        isDragging && !overlay && "opacity-40",
        overlay && "shadow-lg",
      )}
    >
      <span className="flex shrink-0 items-center -space-x-0.5">
        {platforms.slice(0, 2).map((p) => (
          <PlatformGlyph key={p} platform={p} className="size-3" />
        ))}
      </span>
      {when && <span className="text-muted-foreground shrink-0 tabular-nums">{clock(when, tz)}</span>}
      <span className="min-w-0 flex-1 truncate font-medium">{text}</span>
      <span
        className={cn(
          "shrink-0",
          post.status === "published" && "text-success",
          post.status === "failed" && "text-destructive",
          post.status === "scheduled" && "text-primary",
          post.status === "publishing" && "text-warning",
        )}
      >
        {STATUS_ICON[post.status]}
      </span>
    </button>
  );
}

function Droppable({ id, className, children, title }: { id: string; className?: string; children: React.ReactNode; title?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} title={title} className={cn(className, isOver && "bg-accent ring-primary/60 ring-2 ring-inset")}>
      {children}
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_PER_CELL = 3;

export function MonthGrid({
  anchor,
  today,
  byDay,
  tz,
  onOpen,
  onOpenDay,
}: {
  anchor: Ymd;
  today: Ymd;
  byDay: Map<string, PostDTO[]>;
  tz: string;
  onOpen: (id: string) => void;
  onOpenDay: (d: Ymd) => void;
}) {
  const days = visibleDays("month", anchor);
  return (
    <div className="overflow-hidden rounded-2xl border" role="grid" aria-label="Month calendar">
      <div className="bg-muted/50 grid grid-cols-7 border-b text-center text-xs font-medium" role="row">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-muted-foreground py-2" role="columnheader">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const key = ymdKey(d);
          const posts = byDay.get(key) ?? [];
          const inMonth = sameMonth(d, anchor);
          const isToday = sameDay(d, today);
          return (
            <Droppable
              key={key}
              id={`day:${key}`}
              className={cn("min-h-20 space-y-1 border-r border-b p-1 sm:min-h-24 sm:p-1.5", (i + 1) % 7 === 0 && "border-r-0", i >= 35 && "border-b-0", !inMonth && "bg-muted/30")}
            >
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => onOpenDay(d)}
                  aria-label={`Open ${key}`}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
                    !inMonth && "text-muted-foreground/60",
                    isToday && "bg-primary text-primary-foreground hover:bg-primary/90 font-semibold",
                  )}
                >
                  {d.day}
                </button>
              </div>
              {/* Phones: a text chip does not fit in a ~50px cell, so show one dot per post. Tap the day for the list. */}
              {posts.length > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenDay(d)}
                  aria-label={`${posts.length} ${posts.length === 1 ? "post" : "posts"} on ${key}. Open day`}
                  className="flex w-full flex-wrap items-center justify-center gap-1 rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:hidden"
                >
                  {posts.slice(0, 6).map((p) => (
                    <span
                      key={p.id}
                      className={cn("size-2 rounded-full", p.status === "failed" && "ring-destructive ring-2 ring-offset-1", p.status === "draft" && "opacity-50")}
                      style={{ backgroundColor: chipColor(p) }}
                    />
                  ))}
                  {posts.length > 6 && <span className="text-muted-foreground text-[10px] leading-none">+{posts.length - 6}</span>}
                </button>
              )}
              <div className="hidden space-y-1 sm:block">
                {posts.slice(0, MAX_PER_CELL).map((p) => (
                  <PostChip key={p.id} post={p} tz={tz} onOpen={onOpen} />
                ))}
                {posts.length > MAX_PER_CELL && (
                  <button type="button" onClick={() => onOpenDay(d)} className="text-muted-foreground hover:text-foreground w-full px-1 text-left text-[11px] font-medium">
                    +{posts.length - MAX_PER_CELL} more
                  </button>
                )}
              </div>
            </Droppable>
          );
        })}
      </div>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, h)));

/** Week and day views: one column per day, one row per hour. */
export function TimeGrid({
  view,
  anchor,
  today,
  byDay,
  tz,
  onOpen,
}: {
  view: Exclude<CalendarView, "month">;
  anchor: Ymd;
  today: Ymd;
  byDay: Map<string, PostDTO[]>;
  tz: string;
  onOpen: (id: string) => void;
}) {
  const days = view === "week" ? weekDays(anchor) : [anchor];
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Start the view at 7am rather than midnight.
    scroller.current?.scrollTo({ top: 7 * 64 });
  }, [view]);

  const cols = days.length === 1 ? "grid-cols-[3.5rem_1fr]" : "grid-cols-[3.5rem_repeat(7,minmax(7rem,1fr))]";
  return (
    <div className="overflow-hidden rounded-2xl border" role="grid" aria-label={`${view} calendar`}>
      <div ref={scroller} className="max-h-[68vh] overflow-auto">
        <div className={cn("grid min-w-fit", cols)}>
          <div className="bg-background sticky top-0 z-10 border-b" />
          {days.map((d) => {
            const isToday = sameDay(d, today);
            return (
              <div key={ymdKey(d)} className={cn("bg-background sticky top-0 z-10 border-b border-l py-2 text-center text-xs", isToday && "text-primary font-semibold")}>
                <span className="text-muted-foreground">{WEEKDAYS[(new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7]}</span>{" "}
                <span className={cn("inline-flex size-6 items-center justify-center rounded-full tabular-nums", isToday && "bg-primary text-primary-foreground")}>{d.day}</span>
              </div>
            );
          })}

          {HOURS.map((h) => (
            <HourRow key={h} hour={h} days={days} byDay={byDay} tz={tz} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </div>
  );
}

function HourRow({ hour, days, byDay, tz, onOpen }: { hour: number; days: Ymd[]; byDay: Map<string, PostDTO[]>; tz: string; onOpen: (id: string) => void }) {
  return (
    <>
      <div className="text-muted-foreground h-16 border-b pt-1 pr-2 text-right text-[11px] tabular-nums">{hour === 0 ? "" : hourLabel(hour)}</div>
      {days.map((d) => {
        const key = ymdKey(d);
        const inHour = (byDay.get(key) ?? []).filter((p) => fromInstant(postWhen(p)!, tz).hour === hour);
        return (
          <Droppable key={key} id={`slot:${key}:${hour}`} className="min-h-16 min-w-0 space-y-1 border-b border-l p-1" title={`${hourLabel(hour)}`}>
            {inHour.map((p) => (
              <PostChip key={p.id} post={p} tz={tz} onOpen={onOpen} />
            ))}
          </Droppable>
        );
      })}
    </>
  );
}

