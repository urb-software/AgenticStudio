import { describe, expect, it } from 'vitest';
import {
  addressAllowed,
  classifyAddress,
  hostLiteral,
  type RemoteAddressRange,
} from '../remote-address.js';

describe('classifyAddress', () => {
  it.each<[string, RemoteAddressRange]>([
    // Always blocked: unspecified, link-local and metadata, multicast, reserved and broadcast.
    ['0.0.0.0', 'blocked'],
    ['0.1.2.3', 'blocked'],
    ['169.254.169.254', 'blocked'],
    ['169.254.0.1', 'blocked'],
    ['100.100.100.200', 'blocked'],
    ['192.0.0.192', 'blocked'],
    ['168.63.129.16', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['239.255.255.250', 'blocked'],
    ['240.0.0.1', 'blocked'],
    ['255.255.255.255', 'blocked'],
    // Opt-in: loopback, private and CGNAT.
    ['127.0.0.1', 'private'],
    ['127.255.0.9', 'private'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.10', 'private'],
    ['100.64.0.1', 'private'],
    ['100.127.255.254', 'private'],
    // Public, including the neighbours of each range.
    ['8.8.8.8', 'public'],
    ['140.82.121.4', 'public'],
    ['1.0.0.0', 'public'],
    ['126.255.255.255', 'public'],
    ['128.0.0.0', 'public'],
    ['172.15.255.255', 'public'],
    ['172.32.0.0', 'public'],
    ['169.253.255.255', 'public'],
    ['100.63.255.255', 'public'],
    ['100.128.0.0', 'public'],
    ['192.169.0.0', 'public'],
    ['223.255.255.255', 'public'],
  ])('IPv4 %s is %s', (address, range) => {
    expect(classifyAddress(address)).toBe(range);
  });

  it.each<[string, RemoteAddressRange]>([
    ['::', 'blocked'],
    ['fe80::1', 'blocked'],
    ['febf:ffff::1', 'blocked'],
    ['ff02::1', 'blocked'],
    ['fd00:ec2::254', 'blocked'],
    ['::1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456:789a::1', 'private'],
    ['2606:4700:4700::1111', 'public'],
    ['2001:db8::1', 'public'],
    ['FE80::1', 'blocked'],
    ['0:0:0:0:0:0:0:1', 'private'],
    // IPv4-mapped, IPv4-compatible and NAT64 forms count as their IPv4 address.
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:7f00:1', 'private'],
    ['::ffff:169.254.169.254', 'blocked'],
    ['::ffff:a9fe:a9fe', 'blocked'],
    ['::ffff:8.8.8.8', 'public'],
    ['::169.254.169.254', 'blocked'],
    ['::10.0.0.1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'blocked'],
    ['64:ff9b::7f00:1', 'private'],
    ['64:ff9b::808:808', 'public'],
    ['64:ff9b:1::a9fe:a9fe', 'blocked'],
    ['64:ff9b:1::808:808', 'blocked'],
    ['::ffff:0:7f00:1', 'private'],
    ['::ffff:0:a9fe:a9fe', 'blocked'],
    // 6to4 carries its IPv4 address in groups 1 and 2; Teredo's cannot be read: refused.
    ['2002:a9fe:a9fe::1', 'blocked'],
    ['2002:7f00:1::1', 'private'],
    ['2002:808:808::1', 'public'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'blocked'],
    ['2001:4860:4860::8888', 'public'],
  ])('IPv6 %s is %s', (address, range) => {
    expect(classifyAddress(address)).toBe(range);
  });

  it.each(['', 'localhost', '1.2.3', '256.0.0.1', '1.2.3.4.5', '::g', '1::2::3', '[::1]'])(
    'treats %j, which is not an address, as blocked',
    (text) => {
      expect(classifyAddress(text)).toBe('blocked');
    },
  );
});

describe('addressAllowed', () => {
  it('allows public addresses always, private ones only with the opt-in, blocked ones never', () => {
    expect(addressAllowed('8.8.8.8', false)).toBe(true);
    expect(addressAllowed('10.0.0.5', false)).toBe(false);
    expect(addressAllowed('10.0.0.5', true)).toBe(true);
    expect(addressAllowed('169.254.169.254', true)).toBe(false);
    expect(addressAllowed('fd00:ec2::254', true)).toBe(false);
    expect(addressAllowed('100.100.100.200', true)).toBe(false);
  });
});

describe('hostLiteral', () => {
  it.each([
    ['github.com'],
    ['git.example.test'],
    ['localhost'],
    ['1password.com'],
    ['0x7f.example'],
    ['host-0x1'],
  ])('%s is a host name', (host) => {
    expect(hostLiteral(host)).toEqual({ kind: 'name' });
  });

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['127.1', '127.0.0.1'],
    ['0x7f.1', '127.0.0.1'],
    ['0x7F.0.0.1', '127.0.0.1'],
    ['2130706433', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['017700000001', '127.0.0.1'],
    ['0177.0.0.1', '127.0.0.1'],
    ['169.254.43518', '169.254.169.254'],
    ['10.1.2', '10.1.0.2'],
    ['0', '0.0.0.0'],
    ['[::1]', '::1'],
    ['[::ffff:7f00:1]', '::ffff:7f00:1'],
    ['[FE80::1]', 'fe80::1'],
  ])('%s is the address %s', (host, address) => {
    expect(hostLiteral(host)).toEqual({ kind: 'address', address });
  });

  it.each([
    ['256.0.0.1'],
    ['1.2.3.4.5'],
    ['08.1'],
    ['0x'],
    ['0x100000000'],
    ['4294967296'],
    ['1.16777216'],
    ['[::g]'],
    ['[1::2::3]'],
  ])('%s is a numeric host that is no valid address', (host) => {
    expect(hostLiteral(host)).toEqual({ kind: 'invalid' });
  });
});
