import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import type { DbUser } from "@/lib/db/schema";
import type { PlanKey } from "@/lib/constants";
import { unauthorized } from "@/lib/errors";
import { getUserPlan } from "@/lib/plans";
import { getUserByClerkId, upsertUser } from "@/lib/users";

export interface AuthedContext {
  clerkUserId: string;
  user: DbUser;
  plan: PlanKey;
}

/**
 * Resolve the signed-in user for an API route or server component.
 * Creates the DB row lazily if the Clerk webhook has not arrived yet
 * (always the case in a fresh dev setup without a tunnel).
 */
export async function requireUser(): Promise<AuthedContext> {
  const session = await auth();
  if (!session.userId) throw unauthorized();

  let user = await getUserByClerkId(session.userId);
  if (!user) {
    const cu = await currentUser();
    user = await upsertUser(session.userId, {
      email: cu?.primaryEmailAddress?.emailAddress ?? cu?.emailAddresses[0]?.emailAddress ?? null,
      name: [cu?.firstName, cu?.lastName].filter(Boolean).join(" ") || cu?.username || null,
      imageUrl: cu?.imageUrl ?? null,
    });
  }

  const plan = await getUserPlan(user.id, { clerkHas: (p) => session.has(p) });
  return { clerkUserId: session.userId, user, plan };
}
