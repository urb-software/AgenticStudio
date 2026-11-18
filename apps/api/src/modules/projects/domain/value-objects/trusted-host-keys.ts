import { RepositoryUrl } from './repository-url.js';

export interface KnownHost {
  readonly hosts: readonly string[];
  readonly key: string;
}

export interface HostKeyFacts {
  readonly url: string;
  readonly pinnedHostKey: string | null;
}

/**
 * The host keys Studio trusts for a Repository's Git host: those configured for it and the one pinned
 * for the Repository. Empty for a host Studio must ask about and for a non-SSH URL. Pure.
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

  get isEmpty(): boolean {
    return this.keys.length === 0;
  }
}
