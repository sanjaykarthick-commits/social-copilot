import { NextResponse } from "next/server";

/* Minimal stand-ins for @clerk/nextjs/server. Test harness only (see README.md). */

const userId = () => process.env.E2E_FAKE_USER_ID ?? "user_e2e";

export function clerkMiddleware() {
  return () => NextResponse.next();
}

export function createRouteMatcher() {
  return () => false;
}

export async function auth() {
  return { userId: userId(), has: () => false };
}

export async function currentUser() {
  return {
    id: userId(),
    firstName: "Sanjay",
    lastName: "Karthick",
    username: null,
    imageUrl: "",
    primaryEmailAddress: { emailAddress: "sanjay@example.com" },
    emailAddresses: [{ emailAddress: "sanjay@example.com" }],
  };
}
