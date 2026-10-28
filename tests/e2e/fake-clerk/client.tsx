"use client";

import type { ReactNode } from "react";

/* Minimal stand-ins for the Clerk components the app uses. Test harness only (see README.md). */

export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Show({ when, children }: { when: "signed-in" | "signed-out"; children: ReactNode }) {
  return when === "signed-in" ? <>{children}</> : null;
}

export function UserButton() {
  return (
    <span
      aria-label="Account menu"
      className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
    >
      SK
    </span>
  );
}

export function SignIn() {
  return <div className="rounded-xl border bg-card p-8 text-sm">Sign in (test harness)</div>;
}

export function SignUp() {
  return <div className="rounded-xl border bg-card p-8 text-sm">Sign up (test harness)</div>;
}
