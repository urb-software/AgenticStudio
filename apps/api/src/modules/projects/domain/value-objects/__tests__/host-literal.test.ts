import { describe, expect, it } from 'vitest';
import { HostLiteral } from '../host-literal.js';

describe('HostLiteral', () => {
  it('is a name for a host name', () => {
    const literal = HostLiteral.of('github.com');
    expect(literal.kind).toBe('name');
    expect(literal.isAddress()).toBe(false);
  });

  it('turns inet_aton forms into dotted decimal', () => {
    for (const host of ['2130706433', '0x7f.1', '127.1', '0177.0.0.1']) {
      const literal = HostLiteral.of(host);
      expect(literal.isAddress(), host).toBe(true);
      expect(literal.address, host).toBe('127.0.0.1');
    }
  });

  it('keeps a bracketed IPv6 literal without its brackets, in lower case', () => {
    const literal = HostLiteral.of('[FE80::1]');
    expect(literal.isAddress() && literal.address).toBe('fe80::1');
  });

  it('refuses a numeric host that is no address', () => {
    for (const host of ['1.2.3.4.5', '256.1.1.1', '0x', '08.1', '[nonsense]']) {
      expect(HostLiteral.of(host).kind, host).toBe('invalid');
    }
  });
});
