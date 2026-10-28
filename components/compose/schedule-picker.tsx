"use client";

import { useMemo, useState } from "react";
import { CalendarIcon, Clock, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ceilTo15, formatInTz, fromInstant, normalizeTimeZone, timeZoneOptions, toInstant } from "@/lib/time";
import { cn } from "@/lib/utils";

export interface ScheduleState {
  enabled: boolean;
  /** Wall-clock calendar day in the chosen timezone. */
  day: { year: number; month: number; day: number } | null;
  /** "HH:mm" in the chosen timezone, 15-minute steps. */
  time: string;
}

export const scheduleToInstant = (s: ScheduleState, tz: string): Date | null => {
  if (!s.day) return null;
  const [hour, minute] = s.time.split(":").map(Number);
  return toInstant({ ...s.day, hour, minute }, tz);
};

/** A sensible starting point: the next free quarter hour at least 30 minutes away. */
export function defaultSchedule(tz: string, from: Date = new Date()): ScheduleState {
  const p = fromInstant(ceilTo15(new Date(from.getTime() + 30 * 60_000)), tz);
  return { enabled: true, day: { year: p.year, month: p.month, day: p.day }, time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` };
}

export function scheduleFromInstant(date: Date, tz: string): ScheduleState {
  const p = fromInstant(date, tz);
  return { enabled: true, day: { year: p.year, month: p.month, day: p.day }, time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` };
}

const SLOTS = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const label = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
  return { value, label };
});

export function SchedulePicker({
  value,
  onChange,
  tz,
  onTimeZoneChange,
  now,
  error,
}: {
  value: ScheduleState;
  onChange: (next: ScheduleState) => void;
  tz: string;
  onTimeZoneChange: (tz: string) => void;
  now: Date;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => timeZoneOptions(tz), [tz]);
  const when = scheduleToInstant(value, tz);
  const selected = value.day ? new Date(value.day.year, value.day.month - 1, value.day.day) : undefined;
  const today = fromInstant(now, tz);

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">Schedule for later</span>
          <span className="text-muted-foreground block text-xs">Off posts right away.</span>
        </span>
        <Switch
          checked={value.enabled}
          onCheckedChange={(checked) => onChange(checked ? (value.day ? { ...value, enabled: true } : defaultSchedule(tz, now)) : { ...value, enabled: false })}
          aria-label="Schedule for later"
        />
      </label>

      {value.enabled && (
        <div className="bg-muted/40 space-y-3 rounded-xl border p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger
                render={
                  <Button type="button" variant="outline" className={cn("h-9 w-full justify-start font-normal", !value.day && "text-muted-foreground")} aria-label="Pick a date" />
                }
              >
                <CalendarIcon aria-hidden />
                {value.day ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(selected) : "Pick a date"}
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={selected}
                  defaultMonth={selected}
                  onSelect={(d) => {
                    if (!d) return;
                    onChange({ ...value, day: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() } });
                    setOpen(false);
                  }}
                  disabled={{ before: new Date(today.year, today.month - 1, today.day) }}
                />
              </PopoverContent>
            </Popover>

            <div className="flex items-center gap-2">
              <Clock className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <NativeSelect className="w-full" aria-label="Time" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })}>
                {SLOTS.map((s) => (
                  <NativeSelectOption key={s.value} value={s.value}>
                    {s.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Globe className="size-3.5 shrink-0" aria-hidden />
            <span>Times are in</span>
            <NativeSelect size="sm" aria-label="Timezone" value={normalizeTimeZone(tz)} onChange={(e) => onTimeZoneChange(e.target.value)} className="max-w-56">
              {zones.map((z) => (
                <NativeSelectOption key={z} value={z}>
                  {z.replaceAll("_", " ")}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          {when && !error && (
            <p className="text-sm">
              Publishes <strong>{formatInTz(when, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</strong>
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
