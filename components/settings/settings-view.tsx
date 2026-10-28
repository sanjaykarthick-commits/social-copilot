"use client";

import { useMemo, useState } from "react";
import { Globe, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/client/api";
import { useSettings } from "@/lib/client/hooks";
import { PLAN_LABEL } from "@/lib/plans-labels";
import { browserTimeZone, formatInTz, normalizeTimeZone, timeZoneOptions } from "@/lib/time";

export function SettingsView() {
  const { data, error, mutate } = useSettings();
  const [saving, setSaving] = useState(false);
  const detected = browserTimeZone();
  const current = normalizeTimeZone(data?.timezone ?? detected);
  const list = useMemo(() => timeZoneOptions(current), [current]);

  async function save(timezone: string) {
    setSaving(true);
    try {
      await api("/api/settings", { method: "PATCH", json: { timezone } });
      await mutate();
      toast.success(`Timezone set to ${timezone.replaceAll("_", " ")}.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHeader title="Settings" description="Your account and how times are shown." />

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(error)}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Sign-in details are managed from your profile menu.</CardDescription>
        </CardHeader>
        <CardContent>
          {data ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_1fr]">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{data.name ?? "Not set"}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all">{data.email ?? "Not set"}</dd>
              <dt className="text-muted-foreground">Plan</dt>
              <dd>
                <Badge variant="secondary">{PLAN_LABEL[data.plan]}</Badge>
              </dd>
            </dl>
          ) : (
            <Skeleton className="h-20 rounded-xl" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="size-4" aria-hidden /> Timezone
          </CardTitle>
          <CardDescription>The calendar, the schedule picker and the dashboard all use this. Posts are stored in UTC, so changing it never moves a scheduled post.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect aria-label="Timezone" value={current} disabled={saving} onChange={(e) => save(e.target.value)} className="min-w-64 max-w-full [&>select]:h-9">
                  {list.map((z) => (
                    <NativeSelectOption key={z} value={z}>
                      {z.replaceAll("_", " ")}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {saving && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />}
                {detected !== current && (
                  <Button variant="outline" size="sm" disabled={saving} onClick={() => save(detected)}>
                    Use my browser&apos;s ({detected.replaceAll("_", " ")})
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground text-sm">It is currently {formatInTz(new Date(), data.timezone, { weekday: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short" })} there.</p>
            </>
          ) : (
            <Skeleton className="h-9 w-64" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
