import { Image as ImageIcon, Video } from "lucide-react";
import { PlatformGlyph } from "@/components/platform-icon";
import { PostStatusBadge } from "@/components/posts/status";
import { postWhen } from "@/components/posts/post-actions";
import { PLATFORM_META } from "@/lib/platforms/meta";
import type { PostDTO } from "@/lib/posts-query";
import { formatInTz } from "@/lib/time";

/** Platforms a post targets, as small brand-colored glyphs. */
export function TargetGlyphs({ post, className }: { post: Pick<PostDTO, "targets">; className?: string }) {
  const seen = new Set<string>();
  const platforms = post.targets.filter((t) => (seen.has(t.platform) ? false : seen.add(t.platform)));
  if (platforms.length === 0) return <span className="text-muted-foreground text-xs">No account</span>;
  return (
    <span className={className ?? "flex items-center -space-x-1"}>
      {platforms.map((t) => (
        <span
          key={t.platform}
          title={PLATFORM_META[t.platform].name}
          className="ring-background flex size-5 items-center justify-center rounded-full text-white ring-2"
          style={{ backgroundColor: PLATFORM_META[t.platform].color }}
        >
          <PlatformGlyph platform={t.platform} className="size-2.5" />
        </span>
      ))}
    </span>
  );
}

export function PostRow({ post, tz, onOpen }: { post: PostDTO; tz: string; onOpen: (id: string) => void }) {
  const when = postWhen(post);
  const images = post.media.filter((m) => m.type === "image").length;
  const videos = post.media.length - images;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(post.id)}
        className="hover:bg-muted/60 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-3"
      >
        <TargetGlyphs post={post} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{post.content.trim() || <span className="text-muted-foreground italic">No text</span>}</span>
          <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            <span>{when ? formatInTz(when, tz) : "No date"}</span>
            {images > 0 && (
              <span className="flex items-center gap-1">
                <ImageIcon className="size-3" aria-hidden /> {images}
              </span>
            )}
            {videos > 0 && (
              <span className="flex items-center gap-1">
                <Video className="size-3" aria-hidden /> {videos}
              </span>
            )}
          </span>
        </span>
        <PostStatusBadge status={post.status} />
      </button>
    </li>
  );
}
