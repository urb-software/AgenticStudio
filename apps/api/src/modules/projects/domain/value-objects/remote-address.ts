import { Ipv4Address } from './ipv4-address.js';
import { Ipv6Address } from './ipv6-address.js';
import type { RemoteAddressRange } from './remote-address-range.js';

/**
 * The address policy for Git remotes (security.md §4): `blocked` addresses are never connected to,
 * `private` ones only under `STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true`, the rest are `public`. Pure; shared
 * by URL validation and the Git adapter, which checks every address a host name resolves to.
 */
export const PRIVATE_REMOTES_SETTING = 'STUDIO_GIT_ALLOW_PRIVATE_REMOTES';

export const REFUSED_RANGE_REASON: Record<Exclude<RemoteAddressRange, 'public'>, string> = {
  private: `Studio connects to loopback and private addresses only with ${PRIVATE_REMOTES_SETTING}=true.`,
  blocked: 'Studio never connects to link-local, cloud metadata, multicast or reserved addresses.',
};

export class RemoteAddress {
  private constructor(readonly range: RemoteAddressRange) {}

  /**
   * An IP address as a resolver returns it (dotted IPv4 or IPv6 text, no brackets). Anything that
   * is not an address is `blocked`: the check fails closed.
   */
  static of(address: string): RemoteAddress {
    const v4 = Ipv4Address.parse(address);
    if (v4 !== null) return new RemoteAddress(v4.range);
    const v6 = address.includes(':') ? Ipv6Address.parse(address) : null;
    return new RemoteAddress(v6 === null ? 'blocked' : v6.range);
  }

  /**
   * Why the address is refused under the opt-in setting's value: `private` when the opt-in would
   * allow it, `blocked` when nothing would, `null` when it is allowed.
   */
  refusedUnder(allowPrivate: boolean): Exclude<RemoteAddressRange, 'public'> | null {
    if (this.range === 'public' || (this.range === 'private' && allowPrivate)) return null;
    return this.range;
  }

  isAllowedUnder(allowPrivate: boolean): boolean {
    return this.refusedUnder(allowPrivate) === null;
  }
}
