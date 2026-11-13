import { describe, expect, it } from 'vitest';
import { clientIpLimitKey } from '../client-ip-limit-key.js';

// #24 operator decision: per-IP login limits aggregate IPv6 by /64; IPv4 stays per
// address, and IPv4-mapped IPv6 counts as the IPv4 address.

describe('clientIpLimitKey', () => {
  it.each(['203.0.113.7', '10.0.0.1', '127.0.0.1'])('keeps IPv4 %s per address', (ip) => {
    expect(clientIpLimitKey(ip)).toBe(ip);
  });

  it('gives different IPv4 addresses in one /24 different keys', () => {
    expect(clientIpLimitKey('203.0.113.7')).not.toBe(clientIpLimitKey('203.0.113.8'));
  });

  it.each([
    ['full form', '2001:0db8:0001:0002:0003:0004:0005:0006', '2001:db8:1:2::/64'],
    ['without leading zeros', '2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['upper case', '2001:DB8:1:2:AAAA:BBBB:CCCC:DDDD', '2001:db8:1:2::/64'],
    ['compressed interface ID', '2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['compressed prefix', '2001:db8::1', '2001:db8:0:0::/64'],
    ['compression across the boundary', '2001:db8:1::2:3', '2001:db8:1:0::/64'],
    ['trailing compression', '2001:db8:1:2::', '2001:db8:1:2::/64'],
    ['loopback', '::1', '0:0:0:0::/64'],
    ['unspecified', '::', '0:0:0:0::/64'],
    ['embedded IPv4 tail (not mapped)', '64:ff9b::203.0.113.7', '64:ff9b:0:0::/64'],
  ])('reduces IPv6 to its /64 (%s)', (_case, ip, key) => {
    expect(clientIpLimitKey(ip)).toBe(key);
  });

  it('gives every address in one /64 the same key', () => {
    const keys = new Set(
      ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2:a:b:c:d'].map(
        clientIpLimitKey,
      ),
    );

    expect(keys.size).toBe(1);
  });

  it('gives neighbouring /64s different keys', () => {
    expect(clientIpLimitKey('2001:db8:1:2::1')).not.toBe(clientIpLimitKey('2001:db8:1:3::1'));
  });

  it.each([
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['fe80::abcd:1%en1', 'fe80:0:0:0::/64'],
    ['fe80::1%25', 'fe80:0:0:0::/64'],
  ])('ignores the zone ID of %s', (ip, key) => {
    expect(clientIpLimitKey(ip)).toBe(key);
  });

  it.each([
    ['dotted', '::ffff:203.0.113.7'],
    ['dotted, upper case', '::FFFF:203.0.113.7'],
    ['hex', '::ffff:cb00:7107'],
    ['fully expanded', '0:0:0:0:0:ffff:cb00:7107'],
  ])('treats IPv4-mapped IPv6 as its IPv4 address (%s)', (_case, ip) => {
    expect(clientIpLimitKey(ip)).toBe('203.0.113.7');
  });

  it('does not treat an IPv4-compatible or other ::/96 address as mapped', () => {
    expect(clientIpLimitKey('::203.0.113.7')).toBe('0:0:0:0::/64');
  });

  it.each(['unknown', '', 'not-an-ip', '2001:db8::1::2'])(
    'passes a value that is not an IP address (%j) through unchanged',
    (value) => {
      expect(clientIpLimitKey(value)).toBe(value);
    },
  );
});
