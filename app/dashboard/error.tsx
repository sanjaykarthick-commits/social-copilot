"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center">
      <AlertTriangle className="text-destructive size-8" aria-hidden />
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground text-sm">{error.digest ? `Reference: ${error.digest}. ` : ""}Try again, and if it keeps happening let us know.</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
