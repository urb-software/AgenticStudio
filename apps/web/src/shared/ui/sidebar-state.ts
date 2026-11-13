// Kept out of sidebar.tsx ('use client'): a Server Component importing a constant from a client
// module would get a client reference, not the string.

/**
 * The cookie that stores the operator's explicit choice of an expanded (`true`) or collapsed
 * (`false`) desktop sidebar, so the server renders it without a flash. A UI preference only:
 * not a session cookie, no identity, readable by scripts.
 */
export const SIDEBAR_COOKIE_NAME = 'sidebar_state';

/** One year: a preference, not a credential. */
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The stored choice, or `undefined` when there is none (the width-based default applies). */
export function parseSidebarOpen(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
