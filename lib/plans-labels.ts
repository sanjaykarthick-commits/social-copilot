import type { PlanKey } from "@/lib/constants";

/** Client-safe plan labels (lib/plans.ts imports the database and cannot be used in the browser). */
export const PLAN_LABEL: Record<PlanKey, string> = { free: "Free", premium: "Premium" };
