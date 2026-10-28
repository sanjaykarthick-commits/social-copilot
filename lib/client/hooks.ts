"use client";

import useSWR from "swr";
import type { PublicAccount } from "@/lib/accounts";
import type { PlanKey, Platform } from "@/lib/constants";
import { browserTimeZone } from "@/lib/time";
import { fetcher } from "@/lib/client/api";

export interface AccountsResponse {
  accounts: PublicAccount[];
  plan: PlanKey;
  limit: { used: number; max: number };
  platforms: { id: Platform; implemented: boolean; configured: boolean }[];
}

export function useAccounts() {
  return useSWR<AccountsResponse>("/api/accounts", fetcher);
}

export interface SettingsResponse {
  timezone: string;
  plan: PlanKey;
  email: string | null;
  name: string | null;
}

export function useSettings() {
  return useSWR<SettingsResponse>("/api/settings", fetcher, { revalidateOnFocus: false });
}

/**
 * The timezone every date in the UI is shown and entered in. The saved setting
 * wins; until it loads (or if the request fails) fall back to the browser's.
 */
export function useTimezone(): { tz: string; ready: boolean } {
  const { data, error } = useSettings();
  // `ready` also flips on error so a failed settings request never leaves a page loading forever.
  return { tz: data?.timezone ?? browserTimeZone(), ready: Boolean(data) || Boolean(error) };
}
