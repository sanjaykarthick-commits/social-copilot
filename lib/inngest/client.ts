import { Inngest } from "inngest";

/**
 * Local dev: run `npx inngest-cli@latest dev` and set INNGEST_DEV=1.
 * Production: INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY come from the Vercel
 * integration and INNGEST_DEV must be removed.
 */
export const inngest = new Inngest({ id: "social-copilot" });
