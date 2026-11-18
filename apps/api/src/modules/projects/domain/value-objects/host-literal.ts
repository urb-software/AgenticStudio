import { Ipv6Address } from './ipv6-address.js';

/**
 * What the host of a remote URL is: a name, an address (`address` set), or a numeric host that is
 * no valid address (`invalid`, refused).
 */
export class HostLiteral {
  private static readonly NUMERIC_LABEL = /^(?:0x[\da-f]*|\d+)$/i;

  private constructor(
    readonly kind: 'name' | 'address' | 'invalid',
    readonly address?: string,
  ) {}

  private static inetAtonPart(part: string): number | null {
    if (/^0x[\da-f]+$/i.test(part)) return parseInt(part.slice(2), 16);
    if (/^0[0-7]*$/.test(part)) return parseInt(part, 8);
    if (/^[1-9]\d*$/.test(part)) return Number(part);
    return null;
  }

  /**
   * Normalizes the host of a remote URL. A bracketed IPv6 literal or an all-numeric host is an address:
   * `inet_aton` forms (`127.1`, `0x7f.1`, `2130706433`) become dotted decimal, so the policy sees the
   * address the connection would use. Anything else is a host name.
   */
  static of(host: string): HostLiteral {
    if (host.startsWith('[') && host.endsWith(']')) {
      const inner = host.slice(1, -1).toLowerCase();
      return Ipv6Address.parse(inner) === null
        ? new HostLiteral('invalid')
        : new HostLiteral('address', inner);
    }
    const labels = host.split('.');
    if (!labels.every((label) => HostLiteral.NUMERIC_LABEL.test(label))) {
      return new HostLiteral('name');
    }
    if (labels.length > 4) return new HostLiteral('invalid');
    const values = labels.map(HostLiteral.inetAtonPart);
    if (values.some((value) => value === null)) return new HostLiteral('invalid');
    const numbers = values as number[];
    const last = numbers.pop()!;
    if (numbers.some((value) => value > 255)) return new HostLiteral('invalid');
    if (last >= 2 ** (8 * (4 - numbers.length))) return new HostLiteral('invalid');
    let address = last;
    numbers.forEach((value, index) => {
      address += value * 2 ** (8 * (3 - index));
    });
    const bytes = [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255];
    return new HostLiteral('address', bytes.join('.'));
  }
}
