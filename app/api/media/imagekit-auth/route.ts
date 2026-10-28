import { getUploadAuthParams } from "@imagekit/next/server";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { requireEnv } from "@/lib/env";

export const runtime = "nodejs";

/** Short-lived signed parameters so the browser can upload straight to ImageKit. */
export const GET = handle(async () => {
  await requireUser();
  const { IMAGEKIT_PRIVATE_KEY, NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY, NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT } = requireEnv(
    "IMAGEKIT_PRIVATE_KEY",
    "NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY",
    "NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT",
  );
  const { token, expire, signature } = getUploadAuthParams({
    privateKey: IMAGEKIT_PRIVATE_KEY, // never leaves the server
    publicKey: NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY,
    // An absolute Unix time (seconds), not a duration; ImageKit accepts up to 1 hour ahead.
    expire: Math.floor(Date.now() / 1000) + 30 * 60,
  });
  return Response.json({ token, expire, signature, publicKey: NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY, urlEndpoint: NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT });
});
