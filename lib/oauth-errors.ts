/** Client-safe: the accounts page turns ?error=<code> into a readable toast. */
export const OAUTH_ERRORS: Record<string, string> = {
  denied: "You cancelled the connection, so nothing was changed.",
  invalid_callback: "The platform sent back an incomplete response. Please try connecting again.",
  state_missing: "Your connection attempt expired. Please try connecting again.",
  state_mismatch: "The security check failed (state mismatch). Please try connecting again.",
  session_mismatch: "You were signed in as a different user when the connection started. Please try again.",
  token_exchange: "Token exchange failed. Check the app credentials and the callback URL, then try again.",
  not_configured: "This platform is not configured on this server yet. See SETUP_CHECKLIST.md.",
  coming_soon: "That platform is not available yet.",
  plan_limit: "You have reached the account limit for your plan.",
  unknown_platform: "Unknown platform.",
  internal: "Something went wrong on our side. Please try again.",
};

export const oauthErrorMessage = (code: string | null | undefined) =>
  (code && OAUTH_ERRORS[code]) || OAUTH_ERRORS.internal;
