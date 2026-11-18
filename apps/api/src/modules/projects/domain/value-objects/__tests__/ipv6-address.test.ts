import { describe, expect, it } from 'vitest';
import { Ipv6Address } from '../ipv6-address.js';

describe('Ipv6Address', () => {
  it.each(['', ':::', '1::2::3', '1:2:3:4:5:6:7', 'g::1', '::1.2.3', '12345::1'])(
    'does not parse %j',
    (text) => {
      expect(Ipv6Address.parse(text)).toBeNull();
    },
  );

  it.each([
    ['::', 'blocked'],
    ['::1', 'private'],
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'blocked'],
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b:1::1', 'blocked'],
    ['2001::1', 'blocked'],
    ['2002:7f00:1::', 'private'],
    ['fe80::1', 'blocked'],
    ['ff02::1', 'blocked'],
    ['fd00:ec2::254', 'blocked'],
    ['fd20:ce::254', 'blocked'],
    ['fc00::1', 'private'],
    ['fec0::1', 'private'],
    ['2606:4700::1111', 'public'],
  ] as const)('puts %s in the %s range', (text, range) => {
    expect(Ipv6Address.parse(text)?.range).toBe(range);
  });

  it('reads upper case and a trailing dotted IPv4', () => {
    expect(Ipv6Address.parse('FE80::1')?.range).toBe('blocked');
    expect(Ipv6Address.parse('::ffff:8.8.8.8')?.range).toBe('public');
  });
});
