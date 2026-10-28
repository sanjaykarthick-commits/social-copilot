"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { upload } from "@imagekit/next";
import { ImagePlus, Loader2, Play, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { api, ApiClientError, errorMessage } from "@/lib/client/api";
import { MAX_MEDIA_BYTES } from "@/lib/media";
import { cn } from "@/lib/utils";

export interface MediaItem {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  type: "image" | "video";
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
}

interface UploadAuth {
  token: string;
  expire: number;
  signature: string;
  publicKey: string;
}

interface InFlight {
  key: string;
  name: string;
  progress: number;
}

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** ImageKit serves resized variants from the same URL, so thumbnails need no extra storage. */
const thumb = (m: MediaItem) => (m.type === "image" ? `${m.url}${m.url.includes("?") ? "&" : "?"}tr=w-320,h-320,c-at_max` : m.thumbnailUrl);

export function MediaUploader({
  value,
  onChange,
  max = 10,
  onBusyChange,
}: {
  value: MediaItem[];
  /** A React state setter, so concurrent uploads that finish out of order never overwrite each other. */
  onChange: Dispatch<SetStateAction<MediaItem[]>>;
  max?: number;
  onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [inflight, setInflight] = useState<InFlight[]>([]);
  const [dragging, setDragging] = useState(false);
  const setBusy = (list: InFlight[]) => {
    setInflight(list);
    onBusyChange?.(list.length > 0);
  };

  async function uploadOne(file: File, key: string): Promise<MediaItem | null> {
    const isVideo = file.type.startsWith("video/");
    if (!isVideo && !file.type.startsWith("image/")) {
      toast.error(`${file.name}: only images and videos can be uploaded.`);
      return null;
    }
    if (file.size > (isVideo ? MAX_MEDIA_BYTES : MAX_IMAGE_BYTES)) {
      toast.error(`${file.name} is too large (max ${isVideo ? "512 MB" : "20 MB"}).`);
      return null;
    }
    try {
      const auth = await api<UploadAuth>("/api/media/imagekit-auth");
      const res = await upload({
        file,
        fileName: file.name,
        token: auth.token,
        expire: auth.expire,
        signature: auth.signature,
        publicKey: auth.publicKey,
        folder: "/social-copilot",
        useUniqueFileName: true,
        onProgress: (e) => {
          const pct = e.total ? (e.loaded / e.total) * 100 : 0;
          setInflight((cur) => cur.map((f) => (f.key === key ? { ...f, progress: pct } : f)));
        },
      });
      if (!res.fileId || !res.url) throw new Error("ImageKit did not return a file.");
      const { media } = await api<{ media: MediaItem }>("/api/media", {
        method: "POST",
        json: {
          fileId: res.fileId,
          url: res.url,
          thumbnailUrl: res.thumbnailUrl ?? null,
          type: isVideo ? "video" : "image",
          width: res.width ?? null,
          height: res.height ?? null,
          sizeBytes: res.size ?? file.size,
        },
      });
      return media;
    } catch (e) {
      const config = e instanceof ApiClientError && e.code === "CONFIG_MISSING";
      toast.error(config ? "Media storage is not configured on this server (ImageKit keys)." : `${file.name}: ${errorMessage(e)}`);
      return null;
    }
  }

  async function addFiles(files: FileList | File[]) {
    const room = max - value.length - inflight.length;
    const list = [...files].slice(0, Math.max(room, 0));
    if (files.length > list.length) toast.warning(`You can attach up to ${max} files.`);
    if (!list.length) return;

    const batch = list.map((f, i) => ({ f, key: `${Date.now()}-${i}-${f.name}` }));
    setBusy([...inflight, ...batch.map(({ f, key }) => ({ key, name: f.name, progress: 0 }))]);
    const done = await Promise.all(
      batch.map(async ({ f, key }) => {
        const item = await uploadOne(f, key);
        setInflight((cur) => {
          const next = cur.filter((x) => x.key !== key);
          onBusyChange?.(next.length > 0);
          return next;
        });
        return item;
      }),
    );
    const added = done.filter((m): m is MediaItem => m !== null);
    if (added.length) onChange((prev) => [...prev, ...added].slice(0, max));
  }

  return (
    <div className="space-y-3">
      {(value.length > 0 || inflight.length > 0) && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
          {value.map((m) => (
            <li key={m.id} className="bg-muted group relative aspect-square overflow-hidden rounded-xl border">
              {m.type === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element -- ImageKit already serves a resized variant
                <img src={thumb(m) ?? m.url} alt="" className="size-full object-cover" />
              ) : (
                <>
                  <video src={`${m.url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-cover" />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white">
                    <Play className="size-6 fill-current" aria-hidden />
                  </span>
                </>
              )}
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                className="absolute top-1 right-1 opacity-100 shadow-sm sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
                aria-label="Remove file"
                onClick={() => onChange((prev) => prev.filter((x) => x.id !== m.id))}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
          {inflight.map((f) => (
            <li key={f.key} className="bg-muted flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border p-2">
              <Loader2 className="text-muted-foreground size-5 animate-spin" aria-hidden />
              <Progress value={f.progress} aria-label={`Uploading ${f.name}`} />
              <span className="text-muted-foreground w-full truncate text-center text-[11px]">{f.name}</span>
            </li>
          ))}
        </ul>
      )}

      {value.length + inflight.length < max && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void addFiles(e.dataTransfer.files);
          }}
          className={cn(
            "text-muted-foreground hover:bg-muted/60 focus-visible:ring-ring/50 flex w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 py-6 text-sm transition-colors outline-none focus-visible:ring-3",
            dragging && "border-primary bg-accent text-accent-foreground",
          )}
        >
          <ImagePlus className="size-5" aria-hidden />
          <span className="font-medium">Add photos or a video</span>
          <span className="text-xs">Click or drop files here. JPG, PNG, WebP, GIF, MP4, MOV</span>
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
    </div>
  );
}
