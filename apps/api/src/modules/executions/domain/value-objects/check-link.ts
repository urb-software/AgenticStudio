import type { LogRedaction } from './log-redaction.js';

/**
 * Never stored half-masked: a secret inside the host or path would leave text that is no address.
 */
export class CheckLink {
  private constructor(private readonly url: string) {}

  static of(url: string): CheckLink {
    return new CheckLink(url);
  }

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
