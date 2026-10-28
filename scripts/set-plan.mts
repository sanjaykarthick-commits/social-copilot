/**
 * Billing is not built yet, so the owner sets plans by hand:
 *   npm run plan:set -- you@example.com premium
 * The person must have signed in once (that creates their row). Prints nothing secret.
 */
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const [email, plan] = process.argv.slice(2);
if (!email || !["free", "premium"].includes(plan ?? "")) {
  console.error("Usage: npm run plan:set -- <email> <free|premium>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (.env.local).");
  process.exit(2);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const r = await client.query(
    `update subscriptions s set plan = $2, status = 'active', current_period_end = null, updated_at = now()
       from users u where u.id = s.user_id and lower(u.email) = lower($1) returning u.email`,
    [email, plan],
  );
  if (r.rowCount === 0) {
    console.error(`No user with the email ${email}. Sign in to the app once with that email, then run this again.`);
    process.exitCode = 1;
  } else {
    console.log(`${r.rows[0].email} is now on the ${plan} plan.`);
  }
} finally {
  await client.end();
}
