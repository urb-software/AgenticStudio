import { Ipv4Address } from './ipv4-address.js';
import type { RemoteAddressRange } from './remote-address-range.js';

/** An IPv6 address as its eight 16-bit groups. */
export class Ipv6Address {
  private constructor(private readonly groups: readonly number[]) {}

  /** IPv6 text without brackets; `null` when it is not an address. */
  static parse(text: string): Ipv6Address | null {
    let rest = text.toLowerCase();
    const lastColon = rest.lastIndexOf(':');
    if (lastColon !== -1 && rest.includes('.', lastColon)) {
      // A trailing dotted IPv4 (`::ffff:127.0.0.1`) is written as its two groups (`::ffff:7f00:1`).
      const embedded = Ipv4Address.parse(rest.slice(lastColon + 1));
      if (embedded === null) return null;
      rest = `${rest.slice(0, lastColon + 1)}${(embedded.value >>> 16).toString(16)}:${(embedded.value & 0xffff).toString(16)}`;
    }
    const halves = rest.split('::');
    if (halves.length > 2) return null;
    const parse = (half: string): number[] | null => {
      if (half === '') return [];
      const groups = half.split(':');
      if (!groups.every((group) => /^[\da-f]{1,4}$/.test(group))) return null;
      return groups.map((group) => parseInt(group, 16));
    };
    const head = parse(halves[0]!);
    const back = halves.length === 2 ? parse(halves[1]!) : [];
    if (head === null || back === null) return null;
    const explicit = head.length + back.length;
    if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
    return new Ipv6Address([...head, ...new Array<number>(8 - explicit).fill(0), ...back]);
  }

  get range(): RemoteAddressRange {
    const [g0, g1, g2, g3, g4, g5, g6, g7] = this.groups as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const embedded = ((g6 << 16) | g7) >>> 0;
    const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    if (upperZero && g5 === 0) {
      if (g6 === 0 && g7 === 0) return 'blocked';
      if (g6 === 0 && g7 === 1) return 'private';
      return Ipv4Address.fromNumber(embedded).range;
    }
    if (upperZero && g5 === 0xffff) return Ipv4Address.fromNumber(embedded).range;
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
      return Ipv4Address.fromNumber(embedded).range;
    }
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return Ipv4Address.fromNumber(embedded).range;
    }
    // Local-use NAT64 64:ff9b:1::/48 (RFC 8215) places the IPv4 address by an operator-chosen
    // prefix length, and Teredo 2001::/32 tunnels to an obfuscated one: neither can be read
    // reliably, so both fail closed.
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return 'blocked';
    if (g0 === 0x2001 && g1 === 0) return 'blocked';
    if (g0 === 0x2002) return Ipv4Address.fromNumber(((g1 << 16) | g2) >>> 0).range;
    if ((g0 & 0xffc0) === 0xfe80) return 'blocked';
    if ((g0 & 0xff00) === 0xff00) return 'blocked';
    // IPv6 metadata services inside the private range below: AWS `fd00:ec2::254` and Google Cloud
    // `fd20:ce::254`; both end in groups 2 to 7 of `::254`.
    const interfaceIs254 = g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0x254;
    if (interfaceIs254 && ((g0 === 0xfd00 && g1 === 0xec2) || (g0 === 0xfd20 && g1 === 0xce))) {
      return 'blocked';
    }
    if ((g0 & 0xfe00) === 0xfc00) return 'private';
    if ((g0 & 0xffc0) === 0xfec0) return 'private';
    return 'public';
  }
}
