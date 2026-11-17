import type { LogRedaction } from './log-redaction.js';

/**
 * A pull request check's link as the Git host gave it (Issue #145). It answers the link Studio
 * stores and shows: after the log redaction, the link itself when redaction left it alone and it
 * is still an http(s) address, otherwise the pull request's checks page. A link is never stored
 * half-masked: a known secret value that happens to be part of its host or path would otherwise
 * leave a text that is no address, which the responses (and so the Run page and the Runs lists)
 * cannot carry.
 */
export class CheckLink {
  private constructor(private readonly url: string) {}

  static of(url: string): CheckLink {
    return new CheckLink(url);
  }

  /** The link to store: itself, or `fallback` (the pull request's checks page). */
  safe(redaction: LogRedaction, fallback: string): string {
    const { url } = this;
    if (redaction.text(url) !== url) return fallback;
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
}
