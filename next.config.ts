import type { NextConfig } from "next";

// When testing OAuth / webhooks through a tunnel (ngrok), Next must allow that
// host in dev. Host only, no protocol.
function tunnelHosts(): string[] {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return [];
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" ? [] : [hostname];
  } catch {
    return [];
  }
}

// Test harness only: lets the real app run in a browser without Clerk credentials.
// Doubly guarded so it can never end up in a production bundle. See tests/e2e/fake-clerk/README.md.
const fakeAuth = process.env.E2E_FAKE_AUTH === "1" && process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  allowedDevOrigins: tunnelHosts(),
  images: {
    // Any host not listed here crashes next/image.
    remotePatterns: [
      { protocol: "https", hostname: "ik.imagekit.io" },
      { protocol: "https", hostname: "pbs.twimg.com" },
      { protocol: "https", hostname: "yt3.ggpht.com" },
      { protocol: "https", hostname: "yt3.googleusercontent.com" },
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "**.cdninstagram.com" },
      { protocol: "https", hostname: "**.fbcdn.net" },
      { protocol: "https", hostname: "media.licdn.com" },
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "images.clerk.dev" },
    ],
  },
  turbopack: {
    ...(fakeAuth
      ? {
          resolveAlias: {
            "@clerk/nextjs/server": "./tests/e2e/fake-clerk/server.ts",
            "@clerk/nextjs": "./tests/e2e/fake-clerk/client.tsx",
          },
        }
      : {}),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
