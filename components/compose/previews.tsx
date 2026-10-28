import { Fragment } from "react";
import { Bookmark, Globe, Heart, MessageCircle, Play, Repeat2, Send, ThumbsUp } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlatformGlyph } from "@/components/platform-icon";
import type { MediaItem } from "@/components/compose/media-uploader";
import type { Platform } from "@/lib/constants";
import { youtubeTitle } from "@/lib/platforms/length";
import { platformName } from "@/lib/platforms/meta";
import { cn } from "@/lib/utils";

export interface PreviewAccount {
  platform: Platform;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
}

const TOKEN = /(https?:\/\/[^\s]+|#[\p{L}\p{N}_]+|@[A-Za-z0-9_]+)/gu;

/** Highlight links, #hashtags and @mentions the way the platform does. */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(TOKEN).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="text-[#1d9bf0] break-all">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Who({ account }: { account: PreviewAccount }) {
  return (
    <div className="flex items-center gap-2.5">
      <Avatar className="size-10">
        {account.profileImageUrl && <AvatarImage src={account.profileImageUrl} alt="" />}
        <AvatarFallback>{(account.displayName ?? account.username ?? "?").slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-semibold">{account.displayName ?? account.username ?? "Your account"}</p>
        {account.username && <p className="text-muted-foreground truncate text-xs">@{account.username}</p>}
      </div>
    </div>
  );
}

function XMedia({ media }: { media: MediaItem[] }) {
  const video = media.find((m) => m.type === "video");
  const images = media.filter((m) => m.type === "image").slice(0, 4);
  if (video) {
    return (
      <div className="relative mt-3 aspect-video overflow-hidden rounded-2xl border bg-black">
        <video src={`${video.url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center text-white">
          <Play className="size-10 fill-current drop-shadow" aria-hidden />
        </span>
      </div>
    );
  }
  if (images.length === 0) return null;
  const cols = images.length === 1 ? "grid-cols-1" : "grid-cols-2";
  return (
    <div className={cn("mt-3 grid gap-0.5 overflow-hidden rounded-2xl border", cols, images.length === 1 ? "aspect-video" : "aspect-[16/9]")}>
      {images.map((m, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- preview of user-uploaded media
        <img key={m.id} src={`${m.url}${m.url.includes("?") ? "&" : "?"}tr=w-640`} alt="" className={cn("size-full object-cover", images.length === 3 && i === 0 && "row-span-2")} />
      ))}
    </div>
  );
}

function XPreview({ account, text, media }: { account: PreviewAccount; text: string; media: MediaItem[] }) {
  return (
    <div className="bg-card rounded-2xl border p-4">
      <div className="flex items-start justify-between">
        <Who account={account} />
        <PlatformGlyph platform="twitter" className="size-4" />
      </div>
      {text.trim() ? (
        <p className="mt-3 text-[15px] leading-snug whitespace-pre-wrap break-words">
          <Linked text={text} />
        </p>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm italic">Your text will appear here.</p>
      )}
      <XMedia media={media} />
    </div>
  );
}

function YouTubePreview({ account, text, media }: { account: PreviewAccount; text: string; media: MediaItem[] }) {
  const video = media.find((m) => m.type === "video");
  const lines = text.split("\n");
  const titleIdx = lines.findIndex((l) => l.trim());
  const description = titleIdx >= 0 ? lines.slice(titleIdx + 1).join("\n").trim() : "";
  return (
    <div className="bg-card overflow-hidden rounded-2xl border">
      <div className="relative aspect-video bg-black">
        {video ? (
          <>
            <video src={`${video.url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center text-white">
              <Play className="size-12 fill-current drop-shadow" aria-hidden />
            </span>
          </>
        ) : (
          <p className="text-muted-foreground absolute inset-0 flex items-center justify-center px-6 text-center text-sm">Attach a video to publish to YouTube.</p>
        )}
      </div>
      <div className="space-y-3 p-4">
        <h3 className="line-clamp-2 text-base leading-snug font-semibold">{text.trim() ? youtubeTitle(text) : "Your title will appear here"}</h3>
        <Who account={account} />
        {description && <p className="text-muted-foreground line-clamp-4 text-sm whitespace-pre-wrap">{description}</p>}
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <ThumbsUp className="size-3.5" aria-hidden /> Public
        </div>
      </div>
    </div>
  );
}

const ikw = (url: string, w: number) => `${url}${url.includes("?") ? "&" : "?"}tr=w-${w}`;

function MediaTile({ m, className }: { m: MediaItem; className?: string }) {
  if (m.type === "video") {
    return (
      <span className={cn("relative block bg-black", className)}>
        <video src={`${m.url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center text-white">
          <Play className="size-10 fill-current drop-shadow" aria-hidden />
        </span>
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- preview of user-uploaded media
  return <img src={ikw(m.url, 640)} alt="" className={cn("block object-cover", className)} />;
}

/** Instagram: media first (no text-only posts), first item shown with carousel dots, caption under the actions. */
function InstagramPreview({ account, text, media }: { account: PreviewAccount; text: string; media: MediaItem[] }) {
  const first = media[0];
  const handle = account.username ?? "your.account";
  // Feed photos are cropped to between 4:5 and 1.91:1; reels show 9:16 in the feed grid but 4:5 in the post.
  const ratio = first?.type === "image" && first.width && first.height ? Math.min(Math.max(first.width / first.height, 0.8), 1.91) : 0.8;
  const short = text.length > 125 ? `${text.slice(0, 125).trimEnd()}… ` : text;
  return (
    <div className="bg-card overflow-hidden rounded-2xl border">
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Avatar className="size-8 ring-2 ring-[#e1306c] ring-offset-2 ring-offset-[var(--card)]">
            {account.profileImageUrl && <AvatarImage src={account.profileImageUrl} alt="" />}
            <AvatarFallback>{handle.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="text-sm font-semibold">{handle}</span>
        </div>
        <PlatformGlyph platform="instagram" className="size-4" />
      </div>
      <div className="relative bg-black" style={{ aspectRatio: String(ratio) }}>
        {first ? (
          <MediaTile m={first} className="size-full" />
        ) : (
          <p className="text-muted-foreground absolute inset-0 flex items-center justify-center bg-muted px-6 text-center text-sm">Instagram needs a photo or video.</p>
        )}
        {media.length > 1 && <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">1/{media.length}</span>}
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-3">
          <Heart className="size-5" aria-hidden />
          <MessageCircle className="size-5" aria-hidden />
          <Send className="size-5" aria-hidden />
          {media.length > 1 && (
            <span className="mx-auto flex gap-1" aria-hidden>
              {media.slice(0, 10).map((m, i) => (
                <span key={m.id} className={cn("size-1.5 rounded-full", i === 0 ? "bg-[#0095f6]" : "bg-muted-foreground/40")} />
              ))}
            </span>
          )}
          <Bookmark className="ml-auto size-5" aria-hidden />
        </div>
        {text.trim() ? (
          <p className="text-sm leading-snug break-words whitespace-pre-wrap">
            <span className="font-semibold">{handle}</span> <Linked text={short} />
            {text.length > 125 && <span className="text-muted-foreground">more</span>}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm italic">Add a caption (optional).</p>
        )}
      </div>
    </div>
  );
}

/** LinkedIn: text first, cut after about three lines with "…see more", then media. */
function LinkedInPreview({ account, text, media }: { account: PreviewAccount; text: string; media: MediaItem[] }) {
  const cut = text.length > 210 || text.split("\n").length > 3;
  const shown = cut ? text.slice(0, 210).split("\n").slice(0, 3).join("\n").trimEnd() : text;
  const images = media.filter((m) => m.type === "image");
  const video = media.find((m) => m.type === "video");
  return (
    <div className="bg-card overflow-hidden rounded-2xl border">
      <div className="flex items-start justify-between p-3">
        <div className="flex items-center gap-2.5">
          <Avatar className="size-12">
            {account.profileImageUrl && <AvatarImage src={account.profileImageUrl} alt="" />}
            <AvatarFallback>{(account.displayName ?? "?").slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold">{account.displayName ?? "Your name"}</p>
            <p className="text-muted-foreground flex items-center gap-1 text-xs">
              Now · <Globe className="size-3" aria-label="Public" />
            </p>
          </div>
        </div>
        <PlatformGlyph platform="linkedin" className="size-4 text-[#0a66c2]" />
      </div>
      {text.trim() ? (
        <p className="px-3 pb-3 text-sm leading-snug break-words whitespace-pre-wrap">
          <Linked text={shown} />
          {cut && <span className="text-muted-foreground">…see more</span>}
        </p>
      ) : (
        !media.length && <p className="text-muted-foreground px-3 pb-3 text-sm italic">Your text will appear here.</p>
      )}
      {video ? (
        <MediaTile m={video} className="aspect-video w-full" />
      ) : images.length === 1 ? (
        <MediaTile m={images[0]} className="max-h-96 w-full" />
      ) : images.length > 1 ? (
        <div className="grid grid-cols-2 gap-0.5">
          {images.slice(0, 4).map((m, i) => (
            <span key={m.id} className="relative">
              <MediaTile m={m} className="aspect-square w-full" />
              {i === 3 && images.length > 4 && <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-xl font-semibold text-white">+{images.length - 4}</span>}
            </span>
          ))}
        </div>
      ) : null}
      <div className="text-muted-foreground flex justify-around border-t px-2 py-2 text-xs font-medium">
        <span className="flex items-center gap-1">
          <ThumbsUp className="size-4" aria-hidden /> Like
        </span>
        <span className="flex items-center gap-1">
          <MessageCircle className="size-4" aria-hidden /> Comment
        </span>
        <span className="flex items-center gap-1">
          <Repeat2 className="size-4" aria-hidden /> Repost
        </span>
      </div>
    </div>
  );
}

function GenericPreview({ account, text }: { account: PreviewAccount; text: string }) {
  return (
    <div className="bg-card rounded-2xl border p-4">
      <Who account={account} />
      <p className="mt-3 text-sm whitespace-pre-wrap">{text || "Your text will appear here."}</p>
      <p className="text-muted-foreground mt-3 text-xs">{platformName(account.platform)} preview is approximate.</p>
    </div>
  );
}

/** A faithful-enough mock of how the post will look on the account's platform. */
export function PostPreview({ account, text, media }: { account: PreviewAccount; text: string; media: MediaItem[] }) {
  if (account.platform === "twitter") return <XPreview account={account} text={text} media={media} />;
  if (account.platform === "youtube") return <YouTubePreview account={account} text={text} media={media} />;
  if (account.platform === "instagram") return <InstagramPreview account={account} text={text} media={media} />;
  if (account.platform === "linkedin") return <LinkedInPreview account={account} text={text} media={media} />;
  return <GenericPreview account={account} text={text} />;
}
