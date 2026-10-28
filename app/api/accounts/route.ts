import { listAccounts } from "@/lib/accounts";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { PLATFORMS } from "@/lib/constants";
import { isPlatformConfigured } from "@/lib/platforms/config";
import { PLATFORM_META } from "@/lib/platforms/meta";
import { getUsage, limitsFor } from "@/lib/plans";

export const runtime = "nodejs";

export const GET = handle(async () => {
  const { user, plan } = await requireUser();
  const [accounts, usage] = await Promise.all([listAccounts(user.id), getUsage(user.id)]);
  return Response.json({
    accounts,
    plan,
    limit: { used: usage.accounts, max: limitsFor(plan).accounts },
    platforms: PLATFORMS.map((id) => ({
      id,
      implemented: PLATFORM_META[id].implemented,
      configured: isPlatformConfigured(id),
    })),
  });
});
