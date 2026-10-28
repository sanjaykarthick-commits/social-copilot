"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { AlertCircle, ExternalLink, Loader2, Pencil, RotateCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PlatformGlyph } from "@/components/platform-icon";
import { PostStatusBadge, TargetStatusText } from "@/components/posts/status";
import { canEdit, deletePostById, hasAnyPublished, postWhen, publishNow } from "@/components/posts/post-actions";
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
import { buttonVariants, Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, fetcher } from "@/lib/client/api";
import { useTimezone } from "@/lib/client/hooks";
import { PLATFORM_META } from "@/lib/platforms/meta";
import type { PostDTO } from "@/lib/posts-query";
import { formatInTz } from "@/lib/time";
import { cn } from "@/lib/utils";

/** Details + actions for one post. Polls while the post is publishing so it flips to Published by itself. */
export function PostDrawer({ postId, onClose }: { postId: string | null; onClose: () => void }) {
  const { tz } = useTimezone();
  const { data, error, mutate } = useSWR<{ post: PostDTO }>(postId ? `/api/posts/${postId}` : null, fetcher, {
    refreshInterval: (d) => (d?.post.status === "publishing" ? 2000 : 0),
  });
  const post = data?.post;
  const [busy, setBusy] = useState<null | "publish" | "delete">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(kind: "publish" | "delete") {
    if (!post) return;
    setBusy(kind);
    try {
      if (kind === "publish") {
        await publishNow(post.id);
        toast.success(post.status === "failed" ? "Retrying the platforms that failed." : "Publishing now.");
        await mutate();
      } else {
        await deletePostById(post.id);
        toast.success("Post deleted.");
        setConfirmDelete(false);
        onClose();
      }
    } catch (e) {
      toast.error(errorMessage(e), { duration: 9000 });
      setConfirmDelete(false);
    } finally {
      setBusy(null);
    }
  }

  const when = post ? postWhen(post) : null;
  const failedCount = post?.targets.filter((t) => t.status === "failed").length ?? 0;

  return (
    <>
      <Sheet open={postId !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
          <SheetHeader className="border-b p-4 pr-12">
            <SheetTitle className="flex items-center gap-2">
              Post details {post && <PostStatusBadge status={post.status} />}
            </SheetTitle>
            <SheetDescription>
              {post ? (when ? `${post.status === "published" ? "Published" : "Scheduled for"} ${formatInTz(when, tz)}` : "Not scheduled yet") : "Loading…"}
            </SheetDescription>
          </SheetHeader>

          {error && !post && (
            <p role="alert" className="text-destructive p-4 text-sm">
              {errorMessage(error)}
            </p>
          )}
          {!post && !error && (
            <div className="space-y-3 p-4">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
            </div>
          )}

          {post && (
            <div className="flex-1 space-y-5 p-4">
              {post.status === "failed" && post.failureReason && (
                <div role="alert" className="border-destructive/30 bg-destructive/5 flex gap-2 rounded-xl border p-3 text-sm">
                  <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
                  <p className="text-destructive break-words">{post.failureReason}</p>
                </div>
              )}

              <section className="space-y-1.5">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Text</h3>
                {post.content.trim() ? <p className="text-sm whitespace-pre-wrap break-words">{post.content}</p> : <p className="text-muted-foreground text-sm italic">No text</p>}
              </section>

              {post.media.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Media</h3>
                  <ul className="grid grid-cols-3 gap-2">
                    {post.media.map((m) => (
                      <li key={m.id} className="bg-muted aspect-square overflow-hidden rounded-lg border">
                        {m.type === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element -- ImageKit-resized thumbnail
                          <img src={`${m.url}${m.url.includes("?") ? "&" : "?"}tr=w-240,h-240,c-at_max`} alt="" className="size-full object-cover" />
                        ) : (
                          <video src={`${m.url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-cover" />
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="space-y-2">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Platforms</h3>
                {post.targets.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No accounts selected.</p>
                ) : (
                  <ul className="space-y-2">
                    {post.targets.map((t) => (
                      <li key={t.id} className="rounded-xl border p-2.5">
                        <div className="flex items-center gap-2">
                          <span className="flex size-6 items-center justify-center rounded-md text-white" style={{ backgroundColor: PLATFORM_META[t.platform].color }}>
                            <PlatformGlyph platform={t.platform} className="size-3.5" />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.account?.username ? `@${t.account.username}` : (t.account?.displayName ?? PLATFORM_META[t.platform].name)}</span>
                          <TargetStatusText status={t.status} />
                        </div>
                        {t.error && <p className="text-destructive mt-1.5 text-xs break-words">{t.error}</p>}
                        {t.platformPostUrl && (
                          <a href={t.platformPostUrl} target="_blank" rel="noreferrer" className="text-primary mt-1.5 inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline">
                            View on {PLATFORM_META[t.platform].name} <ExternalLink className="size-3" aria-hidden />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}

          {post && (
            <div className="bg-background sticky bottom-0 flex flex-wrap items-center gap-2 border-t p-4">
              {post.status === "publishing" ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Publishing…
                </p>
              ) : (
                <>
                  {(post.status === "draft" || post.status === "scheduled") && (
                    <Button variant="brand" className="h-9 rounded-lg" disabled={busy !== null} onClick={() => run("publish")}>
                      {busy === "publish" ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />} Publish now
                    </Button>
                  )}
                  {post.status === "failed" && (
                    <Button variant="brand" className="h-9 rounded-lg" disabled={busy !== null} onClick={() => run("publish")}>
                      {busy === "publish" ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
                      {hasAnyPublished(post) ? `Retry ${failedCount} failed` : "Retry"}
                    </Button>
                  )}
                  {canEdit(post) && (
                    <Link href={`/dashboard/compose?edit=${post.id}`} className={cn(buttonVariants({ variant: "outline" }), "h-9 rounded-lg")}>
                      <Pencil aria-hidden /> Edit
                    </Link>
                  )}
                  <Button variant="ghost" className="text-destructive hover:text-destructive ml-auto h-9 rounded-lg" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
                    <Trash2 aria-hidden /> Delete
                  </Button>
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDelete} onOpenChange={(o) => !o && busy !== "delete" && setConfirmDelete(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              {post?.status === "published"
                ? "This removes it from Social Copilot. It stays on the platforms it was published to."
                : post?.status === "scheduled"
                  ? "It will not be published."
                  : "This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete"}>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy === "delete"} onClick={() => run("delete")}>
              {busy === "delete" ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
