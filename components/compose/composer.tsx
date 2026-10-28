"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR, { mutate as globalMutate } from "swr";
import { AlertTriangle, CalendarClock, Loader2, Send, Save } from "lucide-react";
import { toast } from "sonner";
import { AccountPicker } from "@/components/compose/account-picker";
import { MediaUploader, type MediaItem } from "@/components/compose/media-uploader";
import { PostPreview } from "@/components/compose/previews";
import { SchedulePicker, scheduleFromInstant, scheduleToInstant, type ScheduleState } from "@/components/compose/schedule-picker";
import { PageHeader } from "@/components/page-header";
import { PlatformGlyph } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { PublicAccount } from "@/lib/accounts";
import { api, ApiClientError, errorMessage, fetcher } from "@/lib/client/api";
import { useAccounts, useSettings, useTimezone } from "@/lib/client/hooks";
import { useNow } from "@/lib/client/use-now";
import { countChars } from "@/lib/platforms/length";
import { PLATFORM_META } from "@/lib/platforms/meta";
import type { PostDTO } from "@/lib/posts-query";
import { formatInTz } from "@/lib/time";
import { validateForPublish, type PostBody, type ValidationTarget } from "@/lib/validation/posts";
import { cn } from "@/lib/utils";

interface Selection {
  postAsVideo: boolean;
  /** Per-account text; null means "use the shared text". */
  override: string | null;
}

interface Initial {
  content: string;
  selected: Record<string, Selection>;
  media: MediaItem[];
  schedule: ScheduleState;
}

const EMPTY_SCHEDULE: ScheduleState = { enabled: false, day: null, time: "09:00" };

export function Composer({ editId }: { editId?: string }) {
  const { tz, ready } = useTimezone();
  const { data, error, isLoading } = useSWR<{ post: PostDTO }>(editId ? `/api/posts/${editId}` : null, fetcher);

  if (editId && error) {
    return <Notice title="We couldn't open that post" body={errorMessage(error)} />;
  }
  if ((editId && (isLoading || !data)) || !ready) return <ComposerSkeleton />;

  const post = data?.post;
  if (post && (post.status === "published" || post.status === "publishing")) {
    return (
      <Notice
        title={post.status === "published" ? "This post is already published" : "This post is publishing right now"}
        body="Published posts can't be edited. Create a new post instead."
      />
    );
  }
  if (post && post.targets.some((t) => t.status === "published")) {
    return <Notice title="This post is partly published" body="Part of it already went out, so it can't be edited. Retry the platforms that failed from the post's details." />;
  }

  const initial: Initial = post
    ? {
        content: post.content,
        selected: Object.fromEntries(post.targets.map((t) => [t.socialAccountId, { postAsVideo: t.postAsVideo, override: t.contentOverride }])),
        media: post.media.map((m) => ({ id: m.id, url: m.url, thumbnailUrl: m.thumbnailUrl, type: m.type, sizeBytes: m.sizeBytes })),
        schedule: post.scheduledAt && post.status !== "failed" ? scheduleFromInstant(new Date(post.scheduledAt), tz) : EMPTY_SCHEDULE,
      }
    : { content: "", selected: {}, media: [], schedule: EMPTY_SCHEDULE };

  // Draft with a saved time keeps it, but isn't "enabled" until the user turns scheduling on.
  if (post?.status === "draft" && post.scheduledAt) initial.schedule = { ...scheduleFromInstant(new Date(post.scheduledAt), tz), enabled: false };

  return <ComposerForm key={editId ?? "new"} editId={editId} initial={initial} tz={tz} status={post?.status} />;
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardContent className="space-y-1">
          <h1 className="font-semibold">{title}</h1>
          <p className="text-muted-foreground text-sm">{body}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function ComposerSkeleton() {
  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
      <Skeleton className="hidden h-96 rounded-2xl lg:block" />
    </div>
  );
}

function ComposerForm({ editId, initial, tz, status }: { editId?: string; initial: Initial; tz: string; status?: PostDTO["status"] }) {
  const router = useRouter();
  const now = useNow();
  const { data: accountsData, isLoading: accountsLoading } = useAccounts();
  const { mutate: refreshSettings } = useSettings();

  const [content, setContent] = useState(initial.content);
  const [selected, setSelected] = useState(initial.selected);
  const [media, setMedia] = useState<MediaItem[]>(initial.media);
  const [schedule, setSchedule] = useState(initial.schedule);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState<null | "draft" | "publish">(null);
  const [overrideOpen, setOverrideOpen] = useState<Record<string, boolean>>({});
  const [previewTab, setPreviewTab] = useState<string | null>(null);

  const accounts = accountsData?.accounts;
  const accountById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);
  const selectedIds = Object.keys(selected).filter((id) => accountById.has(id));
  const selectedAccounts = selectedIds.map((id) => accountById.get(id)!);
  const scheduledAt = schedule.enabled ? scheduleToInstant(schedule, tz) : null;
  const hasVideo = media.some((m) => m.type === "video");

  const targets: ValidationTarget[] = selectedAccounts.map((a) => ({
    socialAccountId: a.id,
    platform: a.platform,
    label: `${a.username ? `@${a.username}` : a.displayName ?? "account"} on ${PLATFORM_META[a.platform].name}`,
    postAsVideo: selected[a.id].postAsVideo,
    contentOverride: selected[a.id].override?.trim() ? selected[a.id].override : null,
  }));
  const issues = validateForPublish({
    content,
    targets,
    media: media.map((m) => ({ type: m.type, sizeBytes: m.sizeBytes, isGif: /\.gif($|\?)/i.test(m.url), width: m.width, height: m.height })),
    mode: schedule.enabled ? "schedule" : "now",
    scheduledAt,
    now,
  });
  const scheduleIssue = issues.find((i) => i.field === "schedule")?.message;
  const otherIssues = issues.filter((i) => i.field !== "schedule");
  const showIssues = selectedIds.length > 0 || content.trim().length > 0 || media.length > 0;
  const canPublish = issues.length === 0 && !submitting && !uploading;
  const activeTab = previewTab && selectedIds.includes(previewTab) ? previewTab : (selectedIds[0] ?? null);

  function toggleAccount(a: PublicAccount) {
    setSelected((cur) => {
      if (cur[a.id]) {
        const { [a.id]: _removed, ...rest } = cur;
        void _removed;
        return rest;
      }
      // YouTube can only publish videos, so "Post as video" starts on.
      return { ...cur, [a.id]: { postAsVideo: a.platform === "youtube", override: null } };
    });
  }

  async function changeTimeZone(next: string) {
    try {
      await api("/api/settings", { method: "PATCH", json: { timezone: next } });
      await refreshSettings();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function submit(kind: "draft" | "publish") {
    const mode: PostBody["mode"] = kind === "draft" ? "draft" : schedule.enabled ? "schedule" : "now";
    const body: PostBody = {
      content,
      targets: selectedIds.map((id) => ({
        socialAccountId: id,
        postAsVideo: selected[id].postAsVideo,
        contentOverride: selected[id].override?.trim() ? selected[id].override : null,
      })),
      mediaIds: media.map((m) => m.id),
      mode,
      ...(mode !== "now" && scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : {}),
    };
    setSubmitting(kind);
    try {
      await api<{ post: PostDTO }>(editId ? `/api/posts/${editId}` : "/api/posts", { method: editId ? "PUT" : "POST", json: body });
      await globalMutate((key) => typeof key === "string" && (key.startsWith("/api/posts") || key.startsWith("/api/analytics")));
      if (mode === "draft") {
        toast.success("Draft saved.");
        router.push("/dashboard/posts?status=draft");
      } else if (mode === "schedule" && scheduledAt) {
        toast.success(`Scheduled for ${formatInTz(scheduledAt, tz)}.`);
        router.push("/dashboard/calendar");
      } else {
        toast.success("Publishing now. It will show as published in a moment.");
        router.push("/dashboard/posts");
      }
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "SCHEDULER_UNAVAILABLE") {
        toast.error(e.message, { duration: 12000 });
        const saved = (e.details as { postId?: string } | undefined)?.postId;
        if (saved && !editId) router.replace(`/dashboard/compose?edit=${saved}`);
      } else if (e instanceof ApiClientError && e.code === "PLAN_LIMIT") {
        toast.error(e.message, { duration: 12000 });
      } else {
        toast.error(errorMessage(e), { duration: 8000 });
      }
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 pb-24 lg:pb-0">
      <PageHeader
        title={editId ? "Edit post" : "New post"}
        description="Pick where it goes, write it once, and choose when it publishes."
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Post to</CardTitle>
            </CardHeader>
            <CardContent>
              <AccountPicker accounts={accounts} loading={accountsLoading} selected={new Set(selectedIds)} onToggle={toggleAccount} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Text</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="What do you want to share?"
                aria-label="Post text"
                className="min-h-32 text-base"
                maxLength={5000}
              />
              {selectedAccounts.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label="Character counts">
                  {selectedAccounts.map((a) => {
                    const text = selected[a.id].override?.trim() ? selected[a.id].override! : content;
                    const used = countChars(a.platform, text);
                    const max = PLATFORM_META[a.platform].maxChars;
                    const over = used > max;
                    return (
                      <li
                        key={a.id}
                        className={cn(
                          "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs tabular-nums",
                          over ? "border-destructive/50 bg-destructive/10 text-destructive" : "text-muted-foreground",
                        )}
                      >
                        <PlatformGlyph platform={a.platform} className="size-3" />
                        <span>
                          {used.toLocaleString()} / {max.toLocaleString()}
                        </span>
                        {over && <span className="font-medium">{(used - max).toLocaleString()} over</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Media</CardTitle>
            </CardHeader>
            <CardContent>
              <MediaUploader value={media} onChange={setMedia} onBusyChange={setUploading} />
            </CardContent>
          </Card>

          {selectedAccounts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Per-account options</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                {selectedAccounts.map((a) => {
                  const sel = selected[a.id];
                  const open = overrideOpen[a.id] || sel.override !== null;
                  return (
                    <div key={a.id} className="space-y-3 py-3 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <PlatformGlyph platform={a.platform} className="size-4" />
                        {a.username ? `@${a.username}` : a.displayName}
                        <span className="text-muted-foreground font-normal">on {PLATFORM_META[a.platform].name}</span>
                      </div>

                      {a.platform === "youtube" && (
                        <label className="flex cursor-pointer items-start justify-between gap-3">
                          <span className="space-y-0.5">
                            <span className="block text-sm">Post as video</span>
                            <span className="text-muted-foreground block text-xs">
                              {hasVideo ? "The first line of the text becomes the title." : "Attach a video above. YouTube can't publish text-only posts."}
                            </span>
                          </span>
                          <Switch
                            checked={sel.postAsVideo}
                            onCheckedChange={(v) => setSelected((cur) => ({ ...cur, [a.id]: { ...cur[a.id], postAsVideo: v } }))}
                            aria-label="Post as video"
                          />
                        </label>
                      )}

                      {open ? (
                        <div className="space-y-2">
                          <Textarea
                            value={sel.override ?? content}
                            onChange={(e) => setSelected((cur) => ({ ...cur, [a.id]: { ...cur[a.id], override: e.target.value } }))}
                            aria-label={`Text for ${a.username ?? a.platform}`}
                            className="min-h-24 text-sm"
                            maxLength={5000}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSelected((cur) => ({ ...cur, [a.id]: { ...cur[a.id], override: null } }));
                              setOverrideOpen((cur) => ({ ...cur, [a.id]: false }));
                            }}
                          >
                            Use the shared text
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setOverrideOpen((cur) => ({ ...cur, [a.id]: true }));
                            setSelected((cur) => ({ ...cur, [a.id]: { ...cur[a.id], override: content } }));
                          }}
                        >
                          Customize text for {PLATFORM_META[a.platform].name}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>When</CardTitle>
            </CardHeader>
            <CardContent>
              <SchedulePicker value={schedule} onChange={setSchedule} tz={tz} onTimeZoneChange={changeTimeZone} now={now} error={schedule.enabled ? scheduleIssue : undefined} />
            </CardContent>
          </Card>

          {showIssues && otherIssues.length > 0 && (
            <div role="alert" className="border-destructive/30 bg-destructive/5 space-y-1.5 rounded-xl border p-3 text-sm">
              <p className="text-destructive flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-4" aria-hidden /> Fix these before you {schedule.enabled ? "schedule" : "post"}
              </p>
              <ul className="text-muted-foreground list-disc space-y-0.5 pl-6">
                {otherIssues.map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="bg-background/90 fixed inset-x-0 bottom-0 z-20 flex items-center justify-end gap-2 border-t p-3 backdrop-blur lg:static lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
            <Button type="button" variant="outline" className="h-10 rounded-xl px-4" disabled={Boolean(submitting) || uploading} onClick={() => submit("draft")}>
              {submitting === "draft" ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />} Save draft
            </Button>
            <Button type="button" variant="brand" className="h-10 rounded-xl px-5" disabled={!canPublish} onClick={() => submit("publish")}>
              {submitting === "publish" ? <Loader2 className="animate-spin" aria-hidden /> : schedule.enabled ? <CalendarClock aria-hidden /> : <Send aria-hidden />}
              {schedule.enabled ? (status === "scheduled" ? "Update schedule" : "Schedule post") : "Post now"}
            </Button>
          </div>
        </div>

        <aside className="lg:sticky lg:top-20" aria-label="Preview">
          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
            </CardHeader>
            <CardContent>
              {activeTab && selectedAccounts.length > 0 ? (
                <Tabs value={activeTab} onValueChange={(v) => setPreviewTab(String(v))}>
                  <TabsList className="mb-3 h-auto flex-wrap justify-start">
                    {selectedAccounts.map((a) => (
                      <TabsTrigger key={a.id} value={a.id} className="gap-1.5 px-2.5 py-1">
                        <PlatformGlyph platform={a.platform} className="size-3.5" />
                        <span className="max-w-24 truncate">{a.username ?? PLATFORM_META[a.platform].name}</span>
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {selectedAccounts.map((a) => (
                    <TabsContent key={a.id} value={a.id}>
                      <PostPreview
                        account={a}
                        text={selected[a.id].override?.trim() ? selected[a.id].override! : content}
                        media={media}
                      />
                    </TabsContent>
                  ))}
                </Tabs>
              ) : (
                <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">
                  Select an account to see how your post will look.
                </p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
