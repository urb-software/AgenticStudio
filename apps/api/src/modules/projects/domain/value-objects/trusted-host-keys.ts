import { RepositoryUrl } from './repository-url.js';

/** One configured trusted host key: the known_hosts names of its hosts and the key. */
export interface KnownHost {
  /** Lower-case known_hosts names: `host`, or `[host]:port` for a port other than 22. */
  readonly hosts: readonly string[];
  /** `<type> <base64>`. */
  readonly key: string;
}

/** What the rule needs to know of a Repository: its URL and the host key pinned for it. */
export interface HostKeyFacts {
  readonly url: string;
  readonly pinnedHostKey: string | null;
}

/**
 * The host keys Studio trusts for a Repository's Git host (Issue #62): those configured for
 * that host and the one pinned for the Repository, if any. Empty for a host Studio has to ask
 * about and for a URL that is not SSH. Pure: it gets the Repository's facts and the configured
 * known hosts as values and reads nothing.
 */
export class TrustedHostKeys {
  private constructor(readonly keys: readonly string[]) {}

  /**
   * The known_hosts name of an SSH URL's Git host (`host` or `[host]:port`), else `null` (an
   * HTTPS or unparsable URL). The same naming as `platform/config/ssh-known-hosts.ts`, so the
   * configured hosts and this rule name hosts alike.
   */
  static hostNameOf(url: string): string | null {
    const remote = RepositoryUrl.sshRemoteOf(url);
    if (!remote) return null;
    const name = remote.host.toLowerCase();
    return remote.port === 22 ? name : `[${name}]:${remote.port}`;
  }

  static of(facts: HostKeyFacts, knownHosts: readonly KnownHost[]): TrustedHostKeys {
    const hostName = TrustedHostKeys.hostNameOf(facts.url);
    if (hostName === null) return new TrustedHostKeys([]);
    const configured = knownHosts
      .filter((entry) => entry.hosts.includes(hostName))
      .map((entry) => entry.key);
    return new TrustedHostKeys(
      facts.pinnedHostKey ? [...configured, facts.pinnedHostKey] : configured,
    );
  }

  /** True when no host key is trusted: Studio does not connect. */
  get isEmpty(): boolean {
    return this.keys.length === 0;
  }
}
