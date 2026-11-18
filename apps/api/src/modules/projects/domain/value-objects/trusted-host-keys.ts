import { KnownHostName } from './known-host-name.js';
import type { KnownHost } from './known-host.js';
import type { HostKeyFacts } from './host-key-facts.js';

/**
 * The host keys Studio trusts for a Repository's Git host: those configured for it and the one pinned
 * for the Repository. Empty for a host Studio must ask about and for a non-SSH URL. Pure.
 */
export class TrustedHostKeys {
  private constructor(readonly keys: readonly string[]) {}

  static of(facts: HostKeyFacts, knownHosts: readonly KnownHost[]): TrustedHostKeys {
    const hostName = KnownHostName.of(facts.url);
    if (hostName === null) return new TrustedHostKeys([]);
    const configured = knownHosts
      .filter((entry) => entry.hosts.includes(hostName.value))
      .map((entry) => entry.key);
    return new TrustedHostKeys(
      facts.pinnedHostKey ? [...configured, facts.pinnedHostKey] : configured,
    );
  }

  get isEmpty(): boolean {
    return this.keys.length === 0;
  }
}
