import { describe, expect, it } from 'vitest';
import { RemoteIdentity } from '../remote-identity.js';

describe('RemoteIdentity', () => {
  it('is one remote for the https, ssh and short forms', () => {
    const forms = [
      'https://GitHub.com/acme/shop.git',
      'ssh://git@github.com:22/acme/shop/',
      'git@github.com:acme/shop.git',
    ];
    for (const form of forms) expect(RemoteIdentity.of(form)?.value).toBe('github.com/acme/shop');
  });

  it('keeps a non-default port and the case of the path', () => {
    expect(RemoteIdentity.of('ssh://git@host:2222/Acme/Shop')?.value).toBe('host:2222/Acme/Shop');
  });

  it('is null without a host and a path', () => {
    for (const text of ['', 'not a url', 'https://github.com/', 'git@github.com:']) {
      expect(RemoteIdentity.of(text), text).toBeNull();
    }
  });
});
