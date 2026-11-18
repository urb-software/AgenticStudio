import { isIP } from 'node:net';

const IPV4_TAIL = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function hextetsOf(address: string): number[] {
  // A dotted IPv4 tail (`64:ff9b::203.0.113.7`) is the last two groups.
  const tail = IPV4_TAIL.exec(address);
  let hex = address;
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    const groups = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    hex = address.slice(0, tail.index) + groups;
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)));
  const [head = '', rest] = hex.split('::');
  if (rest === undefined) {
    return parse(head);
  }
  const left = parse(head);
  const right = parse(rest);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * The subject of the per-IP login limit: the IPv4 address or the IPv6 /64, so one client cannot
 * rotate through its own subnet. IPv4-mapped and zone IDs are normalised; non-IPs pass through.
 */
export function clientIpLimitKey(clientIp: string): string {
  if (isIP(clientIp) === 4) {
    return clientIp;
  }
  const address = clientIp.split('%')[0] ?? '';
  if (isIP(address) !== 6) {
    return clientIp;
  }
  const groups = hextetsOf(address.toLowerCase());
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}
