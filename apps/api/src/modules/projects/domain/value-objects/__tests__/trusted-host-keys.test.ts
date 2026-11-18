import { describe, expect, it } from 'vitest';
import { testDeployKey } from './test-deploy-key.js';
import { type KnownHost } from '../known-host.js';
import { KnownHostName } from '../known-host-name.js';
import { TrustedHostKeys } from '../trusted-host-keys.js';

const hostKey = (): string => testDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');
const GITHUB_KEY = hostKey();
const GITHUB_SECOND_KEY = hostKey();
const PORT_KEY = hostKey();
const PINNED_KEY = hostKey();

const KNOWN_HOSTS: readonly KnownHost[] = [
  { hosts: ['github.com'], key: GITHUB_KEY },
  { hosts: ['github.com', 'www.github.com'], key: GITHUB_SECOND_KEY },
  { hosts: ['[git.example.com]:2222'], key: PORT_KEY },
];

const facts = (url: string, pinnedHostKey: string | null = null) => ({ url, pinnedHostKey });

describe('TrustedHostKeys', () => {
  it('lists every configured key of the host', () => {
    expect(TrustedHostKeys.of(facts('git@github.com:acme/shop.git'), KNOWN_HOSTS).keys).toEqual([
      GITHUB_KEY,
      GITHUB_SECOND_KEY,
    ]);
  });

  it('names a host with a port the way known_hosts does', () => {
    const trusted = TrustedHostKeys.of(
      facts('ssh://git@git.example.com:2222/acme/shop.git'),
      KNOWN_HOSTS,
    );

    expect(trusted.keys).toEqual([PORT_KEY]);
  });

  it('does not trust the key of another port or host', () => {
    expect(
      TrustedHostKeys.of(facts('ssh://git@git.example.com/acme/shop.git'), KNOWN_HOSTS).isEmpty,
    ).toBe(true);
    expect(TrustedHostKeys.of(facts('git@gitlab.com:acme/shop.git'), KNOWN_HOSTS).isEmpty).toBe(
      true,
    );
  });

  it('adds the key pinned for the Repository after the configured ones', () => {
    expect(
      TrustedHostKeys.of(facts('git@github.com:acme/shop.git', PINNED_KEY), KNOWN_HOSTS).keys,
    ).toEqual([GITHUB_KEY, GITHUB_SECOND_KEY, PINNED_KEY]);
    expect(
      TrustedHostKeys.of(facts('git@gitlab.com:acme/shop.git', PINNED_KEY), KNOWN_HOSTS).keys,
    ).toEqual([PINNED_KEY]);
  });

  it('trusts nothing for an unlisted host without a pinned key, or with no hosts configured', () => {
    const none = TrustedHostKeys.of(facts('git@gitlab.com:acme/shop.git'), KNOWN_HOSTS);

    expect(none.keys).toEqual([]);
    expect(none.isEmpty).toBe(true);
    expect(TrustedHostKeys.of(facts('git@github.com:acme/shop.git'), []).isEmpty).toBe(true);
  });

  it('trusts nothing for an HTTPS URL, even with a pinned key', () => {
    expect(
      TrustedHostKeys.of(facts('https://github.com/acme/shop.git', PINNED_KEY), KNOWN_HOSTS)
        .isEmpty,
    ).toBe(true);
  });

  it('is not changed by the known hosts it was built from', () => {
    const known: KnownHost[] = [{ hosts: ['github.com'], key: GITHUB_KEY }];
    const trusted = TrustedHostKeys.of(facts('git@github.com:acme/shop.git'), known);

    known.push({ hosts: ['github.com'], key: PORT_KEY });

    expect(trusted.keys).toEqual([GITHUB_KEY]);
  });
});

describe('KnownHostName.of', () => {
  it('is the lower-case host, with the port in brackets unless it is 22', () => {
    expect(KnownHostName.of('git@GitHub.com:acme/shop.git')?.value).toBe('github.com');
    expect(KnownHostName.of('ssh://git@git.example.com:2222/acme/shop.git')?.value).toBe(
      '[git.example.com]:2222',
    );
    expect(KnownHostName.of('ssh://git@git.example.com:22/acme/shop.git')?.value).toBe(
      'git.example.com',
    );
  });

  it('is null for an HTTPS URL or text that is no URL', () => {
    expect(KnownHostName.of('https://github.com/acme/shop.git')).toBeNull();
    expect(KnownHostName.of('not a url')).toBeNull();
  });
});
