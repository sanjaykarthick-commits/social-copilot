import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";

export const runtime = "nodejs";
// Long enough for a video upload + processing step on Vercel.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
