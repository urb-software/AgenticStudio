import { RepositoryUrl } from './repository-url.js';

/**
 * The known_hosts name of an SSH URL's Git host (`host` or `[host]:port`). The same naming as
 * `platform/config/ssh-known-hosts.ts`, so the configured hosts and this rule name hosts alike.
 */
export class KnownHostName {
  private constructor(readonly value: string) {}

  /** `null` for an HTTPS or unparsable URL. */
  static of(url: string): KnownHostName | null {
    const remote = RepositoryUrl.parseOrNull(url)?.ssh;
    if (!remote) return null;
    const name = remote.host.toLowerCase();
    return new KnownHostName(remote.port === 22 ? name : `[${name}]:${remote.port}`);
  }
}
