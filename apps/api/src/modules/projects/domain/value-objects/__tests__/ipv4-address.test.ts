import { describe, expect, it } from 'vitest';
import { Ipv4Address } from '../ipv4-address.js';

describe('Ipv4Address', () => {
  it('parses dotted decimal only', () => {
    expect(Ipv4Address.parse('10.0.0.1')?.value).toBe(Ipv4Address.of(10, 0, 0, 1).value);
    for (const text of ['10.0.0', '10.0.0.256', '010.0.0.1', '10.0.0.1.1', '1e1.0.0.1', '']) {
      expect(Ipv4Address.parse(text), text).toBeNull();
    }
  });

  it.each([
    ['0.0.0.0', 'blocked'],
    ['169.254.169.254', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['255.255.255.255', 'blocked'],
    ['100.100.100.200', 'blocked'],
    ['192.0.0.192', 'blocked'],
    ['168.63.129.16', 'blocked'],
    ['127.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['100.128.0.1', 'public'],
    ['8.8.8.8', 'public'],
  ] as const)('puts %s in the %s range', (text, range) => {
    expect(Ipv4Address.parse(text)?.range).toBe(range);
  });

  it('keeps the range of a number as given', () => {
    expect(Ipv4Address.fromNumber(0x7f000001).range).toBe('private');
  });
});
