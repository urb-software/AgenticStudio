import { redactLogText } from './log-redaction.js';

/**
 * A check's link as Studio stores and shows it (Issue #145), after the log redaction: the link
 * itself when redaction left it alone and it is still an http(s) address, otherwise `fallback`
 * (the pull request's checks page). A link is never stored half-masked: a known secret value that
 * happens to be part of its host or path would otherwise leave a text that is no address, which
 * the responses (and so the Run page and the Runs lists) cannot carry.
 */
export function safeCheckLink(url: string, known: readonly string[], fallback: string): string {
  if (redactLogText(url, known) !== url) return fallback;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username === '' &&
      parsed.password === ''
      ? url
      : fallback;
  } catch {
    return fallback;
  }
}
