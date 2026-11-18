import type { RemoteAddressRange } from './remote-address.js';

type Ipv4Range = readonly [base: number, prefix: number];

/** An IPv4 address as the 32-bit number the address policy tests against its ranges. */
export class Ipv4Address {
  private static readonly BLOCKED: readonly Ipv4Range[] = [
    [Ipv4Address.pack(0, 0, 0, 0), 8],
    [Ipv4Address.pack(169, 254, 0, 0), 16],
    [Ipv4Address.pack(224, 0, 0, 0), 4],
    [Ipv4Address.pack(240, 0, 0, 0), 4],
    // Metadata services outside link-local: Alibaba Cloud, Oracle Cloud, Azure WireServer.
    [Ipv4Address.pack(100, 100, 100, 200), 32],
    [Ipv4Address.pack(192, 0, 0, 192), 32],
    [Ipv4Address.pack(168, 63, 129, 16), 32],
  ];

  private static readonly PRIVATE: readonly Ipv4Range[] = [
    [Ipv4Address.pack(127, 0, 0, 0), 8],
    [Ipv4Address.pack(10, 0, 0, 0), 8],
    [Ipv4Address.pack(172, 16, 0, 0), 12],
    [Ipv4Address.pack(192, 168, 0, 0), 16],
    [Ipv4Address.pack(100, 64, 0, 0), 10],
  ];

  private constructor(readonly value: number) {}

  private static pack(a: number, b: number, c: number, d: number): number {
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }

  static of(a: number, b: number, c: number, d: number): Ipv4Address {
    return new Ipv4Address(Ipv4Address.pack(a, b, c, d));
  }

  static fromNumber(value: number): Ipv4Address {
    return new Ipv4Address(value);
  }

  /** Dotted decimal only (`127.0.0.1`), no leading zeros; `null` for any other text. */
  static parse(text: string): Ipv4Address | null {
    const parts = text.split('.');
    if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part))) return null;
    const bytes = parts.map(Number);
    if (bytes.some((byte) => byte > 255)) return null;
    return Ipv4Address.of(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  }

  private within([base, prefix]: Ipv4Range): boolean {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (this.value & mask) >>> 0 === base;
  }

  get range(): RemoteAddressRange {
    if (Ipv4Address.BLOCKED.some((range) => this.within(range))) return 'blocked';
    if (Ipv4Address.PRIVATE.some((range) => this.within(range))) return 'private';
    return 'public';
  }
}
