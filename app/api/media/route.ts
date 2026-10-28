import { z } from "zod";
import { handle, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { mediaAssets } from "@/lib/db/schema";
import { requireEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { isTrustedMediaUrl, MAX_MEDIA_BYTES } from "@/lib/media";

export const runtime = "nodejs";

const registerSchema = z.object({
  fileId: z.string().min(1).max(200),
  url: z.url(),
  thumbnailUrl: z.url().nullish(),
  type: z.enum(["image", "video"]),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  sizeBytes: z.number().int().positive().max(MAX_MEDIA_BYTES).nullish(),
});

/** After the browser finished uploading to ImageKit, record the asset so a post can attach it. */
export const POST = handle(async (req) => {
  const { user } = await requireUser();
  const { NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT } = requireEnv("NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT");
  const body = await parseBody(req, registerSchema);

  if (!isTrustedMediaUrl(body.url, NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT) || (body.thumbnailUrl && !isTrustedMediaUrl(body.thumbnailUrl, NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT))) {
    throw new AppError("VALIDATION", "That file is not hosted on this app's media storage.", 400);
  }

  const [row] = await getDb()
    .insert(mediaAssets)
    .values({
      userId: user.id,
      imagekitFileId: body.fileId,
      url: body.url,
      thumbnailUrl: body.thumbnailUrl ?? null,
      type: body.type,
      width: body.width ?? null,
      height: body.height ?? null,
      sizeBytes: body.sizeBytes ?? null,
    })
    .returning();

  return Response.json(
    { media: { id: row.id, url: row.url, thumbnailUrl: row.thumbnailUrl, type: row.type, width: row.width, height: row.height, sizeBytes: row.sizeBytes } },
    { status: 201 },
  );
});
