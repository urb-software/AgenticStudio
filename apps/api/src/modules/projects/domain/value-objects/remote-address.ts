/**
 * The address policy for Git remotes (Issue #69, security.md §4): which IP addresses Studio
 * may connect to for a Repository. Pure code, shared by URL validation (an IP-literal URL is
 * a field error at Connect) and by the Git adapter (every address a host name resolves to is
 * checked before Git or ssh starts).
 *
 * - `blocked`, never connected to: unspecified, link-local (with the cloud metadata service
 *   at 169.254.169.254), other known metadata addresses, multicast, reserved and broadcast.
 * - `private`, only with `STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true` (a self-hosted Git server on
 *   the LAN): loopback, the private ranges and CGNAT.
 * - `public`: everything else.
 *
 * IPv4-mapped, IPv4-compatible, IPv4-translated, NAT64 (64:ff9b::/96) and 6to4 IPv6 addresses
 * count as the IPv4 address they carry; local-use NAT64 and Teredo, whose IPv4 address cannot
 * be read reliably, are `blocked`. Documentation, benchmarking (198.18.0.0/15) and the rest of
 * 192.0.0.0/24 are not routed to internal services and stay `public`.
 */
export type RemoteAddressRange = 'public' | 'private' | 'blocked';

/** The setting that opts in to loopback and private remotes; named in refusal messages. */
export const PRIVATE_REMOTES_SETTING = 'STUDIO_GIT_ALLOW_PRIVATE_REMOTES';

/** Why an address of a refused range is refused: one sentence, shared by every message. */
export const REFUSED_RANGE_REASON: Record<Exclude<RemoteAddressRange, 'public'>, string> = {
  private: `Studio connects to loopback and private addresses only with ${PRIVATE_REMOTES_SETTING}=true.`,
  blocked: 'Studio never connects to link-local, cloud metadata, multicast or reserved addresses.',
};

type Ipv4Range = readonly [base: number, prefix: number];

const ipv4 = (a: number, b: number, c: number, d: number): number =>
  ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

const BLOCKED_IPV4: readonly Ipv4Range[] = [
  [ipv4(0, 0, 0, 0), 8],
  [ipv4(169, 254, 0, 0), 16],
  [ipv4(224, 0, 0, 0), 4],
  [ipv4(240, 0, 0, 0), 4],
  // Metadata services outside link-local: Alibaba Cloud, Oracle Cloud, Azure WireServer.
  [ipv4(100, 100, 100, 200), 32],
  [ipv4(192, 0, 0, 192), 32],
  [ipv4(168, 63, 129, 16), 32],
];

const PRIVATE_IPV4: readonly Ipv4Range[] = [
  [ipv4(127, 0, 0, 0), 8],
  [ipv4(10, 0, 0, 0), 8],
  [ipv4(172, 16, 0, 0), 12],
  [ipv4(192, 168, 0, 0), 16],
  [ipv4(100, 64, 0, 0), 10],
];

function inIpv4Range(address: number, [base, prefix]: Ipv4Range): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === base;
}

function classifyIpv4(address: number): RemoteAddressRange {
  if (BLOCKED_IPV4.some((range) => inIpv4Range(address, range))) return 'blocked';
  if (PRIVATE_IPV4.some((range) => inIpv4Range(address, range))) return 'private';
  return 'public';
}

/** Canonical dotted-decimal IPv4 (what a resolver returns) as a number, else `null`. */
function parseDottedIpv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part))) return null;
  const bytes = parts.map(Number);
  if (bytes.some((byte) => byte > 255)) return null;
  return ipv4(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
}

/** An IPv6 address (optionally with a trailing dotted IPv4) as eight 16-bit groups, else `null`. */
function parseIpv6(text: string): number[] | null {
  let rest = text.toLowerCase();
  const lastColon = rest.lastIndexOf(':');
  if (lastColon !== -1 && rest.includes('.', lastColon)) {
    // A trailing dotted IPv4 (`::ffff:127.0.0.1`) is written as its two groups (`::ffff:7f00:1`).
    const embedded = parseDottedIpv4(rest.slice(lastColon + 1));
    if (embedded === null) return null;
    rest = `${rest.slice(0, lastColon + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
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
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...back];
}

function classifyIpv6(groups: number[]): RemoteAddressRange {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
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
    if (g6 === 0 && g7 === 0) return 'blocked'; // ::
    if (g6 === 0 && g7 === 1) return 'private'; // ::1
    return classifyIpv4(embedded); // IPv4-compatible ::a.b.c.d
  }
  if (upperZero && g5 === 0xffff) return classifyIpv4(embedded); // IPv4-mapped
  // IPv4-translated ::ffff:0:a.b.c.d (RFC 2765).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return classifyIpv4(embedded);
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052).
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4(embedded);
  }
  // Local-use NAT64 64:ff9b:1::/48 (RFC 8215) places the IPv4 address by an operator-chosen
  // prefix length, and Teredo 2001::/32 tunnels to an obfuscated one: neither can be read
  // reliably, so both fail closed.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return 'blocked';
  if (g0 === 0x2001 && g1 === 0) return 'blocked';
  // 6to4 2002:wwxx:yyzz::/48 (RFC 3056) carries its IPv4 address in groups 1 and 2.
  if (g0 === 0x2002) return classifyIpv4(((g1 << 16) | g2) >>> 0);
  if ((g0 & 0xffc0) === 0xfe80) return 'blocked'; // link-local
  if ((g0 & 0xff00) === 0xff00) return 'blocked'; // multicast
  // IPv6 metadata services, inside the private range below:
  // - AWS fd00:ec2::254 (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html)
  // - Google Cloud fd20:ce::254 (https://cloud.google.com/compute/docs/metadata/querying-metadata)
  // Both addresses end in groups 2 to 7 of `::254`.
  const interfaceIs254 = g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0x254;
  if (interfaceIs254 && ((g0 === 0xfd00 && g1 === 0xec2) || (g0 === 0xfd20 && g1 === 0xce))) {
    return 'blocked';
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // unique local
  if ((g0 & 0xffc0) === 0xfec0) return 'private'; // deprecated site-local
  return 'public';
}

/**
 * The range of an IP address as a resolver returns it (dotted IPv4 or IPv6 text, no
 * brackets). Anything that is not an address is `blocked`: the check fails closed.
 */
export function classifyAddress(address: string): RemoteAddressRange {
  const v4 = parseDottedIpv4(address);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = address.includes(':') ? parseIpv6(address) : null;
  return v6 === null ? 'blocked' : classifyIpv6(v6);
}

/**
 * Why `address` is refused under the opt-in setting's value: `private` when the opt-in would
 * allow it, `blocked` when nothing would, `null` when it is allowed.
 */
export function refusedRange(
  address: string,
  allowPrivate: boolean,
): Exclude<RemoteAddressRange, 'public'> | null {
  const range = classifyAddress(address);
  if (range === 'public' || (range === 'private' && allowPrivate)) return null;
  return range;
}

/** Whether Studio may connect to `address` under the opt-in setting's value. */
export function addressAllowed(address: string, allowPrivate: boolean): boolean {
  return refusedRange(address, allowPrivate) === null;
}

/** What the host part of a remote URL names. */
export type HostLiteral =
  | { kind: 'name' }
  | { kind: 'address'; address: string }
  /** Looks numeric (every label is a number), but is no valid address: refused. */
  | { kind: 'invalid' };

const NUMERIC_LABEL = /^(?:0x[\da-f]*|\d+)$/i;

/** One `inet_aton` component: hex (`0x`), octal (leading `0`) or decimal; `null` if malformed. */
function inetAtonPart(part: string): number | null {
  if (/^0x[\da-f]+$/i.test(part)) return parseInt(part.slice(2), 16);
  if (/^0[0-7]*$/.test(part)) return parseInt(part, 8);
  if (/^[1-9]\d*$/.test(part)) return Number(part);
  return null;
}

/**
 * Normalizes the host of a remote URL. A bracketed IPv6 literal, or a host whose labels are
 * all numbers, is an address: the numeric forms the system resolver accepts (`inet_aton`:
 * `127.1`, `0x7f.1`, `2130706433`, `0177.0.0.1`) become dotted decimal, so the policy sees
 * the address the connection would really use. Anything else is a host name.
 */
export function hostLiteral(host: string): HostLiteral {
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1).toLowerCase();
    return parseIpv6(inner) === null ? { kind: 'invalid' } : { kind: 'address', address: inner };
  }
  const labels = host.split('.');
  if (!labels.every((label) => NUMERIC_LABEL.test(label))) return { kind: 'name' };
  if (labels.length > 4) return { kind: 'invalid' };
  const values = labels.map(inetAtonPart);
  if (values.some((value) => value === null)) return { kind: 'invalid' };
  const numbers = values as number[];
  const last = numbers.pop()!;
  if (numbers.some((value) => value > 255)) return { kind: 'invalid' };
  if (last >= 2 ** (8 * (4 - numbers.length))) return { kind: 'invalid' };
  let address = last;
  numbers.forEach((value, index) => {
    address += value * 2 ** (8 * (3 - index));
  });
  const bytes = [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255];
  return { kind: 'address', address: bytes.join('.') };
}
