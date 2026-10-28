"use client";

import { useEffect } from "react";
import { mutate } from "swr";
import { api } from "@/lib/client/api";
import { useSettings } from "@/lib/client/hooks";
import { browserTimeZone, isValidTimeZone } from "@/lib/time";

const FLAG = "sc.tz.autodetected";

/**
 * New accounts start on UTC. The first time we see a browser in another timezone
 * we adopt it once (the user can change it in Settings), so "9:00" in the
 * scheduler means 9:00 where they actually are.
 */
export function TimezoneSync() {
  const { data } = useSettings();
  useEffect(() => {
    if (!data || data.timezone !== "UTC") return;
    const tz = browserTimeZone();
    try {
      if (tz === "UTC" || !isValidTimeZone(tz) || localStorage.getItem(FLAG)) return;
      localStorage.setItem(FLAG, "1");
    } catch {
      return; // storage blocked: do nothing rather than overwrite repeatedly
    }
    api("/api/settings", { method: "PATCH", json: { timezone: tz } })
      .then(() => mutate("/api/settings"))
      .catch(() => undefined);
  }, [data]);
  return null;
}
