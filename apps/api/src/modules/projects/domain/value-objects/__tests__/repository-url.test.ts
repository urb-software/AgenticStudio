import { describe, expect, it } from 'vitest';
import { InvalidRepositoryUrlError, remoteIdentity, RepositoryUrl } from '../repository-url.js';

function rejection(input: string, options?: Parameters<typeof RepositoryUrl.parse>[1]): string {
  try {
    RepositoryUrl.parse(input, options);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidRepositoryUrlError);
    return (error as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
}

describe('remoteIdentity (Issue #60 clarification 6)', () => {
  const SAME_REMOTE = [
    'https://github.com/acme/shop',
    'https://github.com/acme/shop.git',
    'https://github.com/acme/shop/',
    'https://github.com/acme/shop.git/',
    'https://GitHub.COM/acme/shop.git',
    'https://github.com:443/acme/shop',
    'git@github.com:acme/shop.git',
    'git@GITHUB.com:acme/shop',
    'ssh://git@github.com/acme/shop.git',
    'ssh://git@github.com:22/acme/shop',
  ];

  it.each(SAME_REMOTE)('maps %s to host plus path', (input) => {
    expect(remoteIdentity(input)).toBe('github.com/acme/shop');
  });

  it('keeps a non-default port: two servers on one host are different remotes', () => {
    expect(remoteIdentity('https://git.example.com:8443/acme/shop.git')).toBe(
      'git.example.com:8443/acme/shop',
    );
    expect(remoteIdentity('ssh://git@git.example.com:2222/acme/shop.git')).toBe(
      'git.example.com:2222/acme/shop',
    );
    expect(remoteIdentity('https://git.example.com/acme/shop.git')).toBe(
      'git.example.com/acme/shop',
    );
  });

  it('keeps the case of the path', () => {
    expect(remoteIdentity('https://github.com/Acme/Shop.git')).toBe('github.com/Acme/Shop');
  });

  it('tells different repositories and hosts apart', () => {
    expect(remoteIdentity('https://github.com/acme/shop-api')).toBe('github.com/acme/shop-api');
    expect(remoteIdentity('https://gitlab.com/acme/shop')).toBe('gitlab.com/acme/shop');
  });

  it('stays linear on many slashes (no polynomial backtracking)', () => {
    const started = performance.now();

    expect(remoteIdentity(`https://github.com/acme/shop${'/'.repeat(200_000)}`)).toBe(
      'github.com/acme/shop',
    );
    expect(remoteIdentity(`https://github.com/${'/'.repeat(200_000)}x`)).toBe('github.com/x');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('gives a file URL its path as identity', () => {
    expect(remoteIdentity('file:///tmp/fixtures/shop.git')).toBe('/tmp/fixtures/shop');
  });

  it.each(['', 'not a url', 'https://github.com', 'https://github.com/', 'https://x/.git'])(
    'has no identity for %j',
    (input) => {
      expect(remoteIdentity(input)).toBeNull();
    },
  );
});

describe('RepositoryUrl.parse', () => {
  it('accepts a public HTTPS URL, trimmed, and keeps it as entered', () => {
    const url = RepositoryUrl.parse('  https://github.com/Acme/Shop.git  ');

    expect(url.value).toBe('https://github.com/Acme/Shop.git');
    expect(url.identity).toBe('github.com/Acme/Shop');
  });

  it.each([
    ['an empty URL', '', 'Enter the repository URL.'],
    ['a blank URL', '   ', 'Enter the repository URL.'],
    [
      'a git+ssh:// URL',
      'git+ssh://git@github.com/acme/shop.git',
      'Use git@host:owner/repo.git or ssh://git@host/owner/repo.git for SSH.',
    ],
    [
      'an http:// URL',
      'http://github.com/acme/shop.git',
      'Use https://. Plain http:// is not allowed.',
    ],
    [
      'a git:// URL',
      'git://github.com/acme/shop.git',
      'The git:// protocol is not allowed. Use https://.',
    ],
  ])('rejects %s with its own message', (_case, input, message) => {
    expect(rejection(input)).toBe(message);
  });

  it.each([
    ['a file:// URL', 'file:///srv/repos/shop.git'],
    ['an absolute path', '/srv/repos/shop.git'],
    ['a relative path', './shop.git'],
    ['a parent-relative path', '../shop'],
    ['a home path', '~/repos/shop.git'],
    ['a Windows drive path', 'C:/repos/shop.git'],
  ])('rejects %s as a local path', (_case, input) => {
    expect(rejection(input)).toMatch(/^Local paths/);
  });

  it.each([
    ['a user and password', 'https://user:secret@github.com/acme/shop.git'],
    ['a token as user', 'https://ghp_token@github.com/acme/shop.git'],
    ['an empty password', 'https://user:@github.com/acme/shop.git'],
    ['an empty user', 'https://:secret@github.com/acme/shop.git'],
  ])('rejects embedded credentials: %s', (_case, input) => {
    expect(rejection(input)).toMatch(/^Remove the user name and password/);
  });

  it.each([
    ['a bare word', 'shop'],
    ['a host without a scheme', 'github.com/acme/shop'],
    ['an unknown scheme', 'ftp://github.com/acme/shop.git'],
    ['no repository path', 'https://github.com'],
    ['a query', 'https://github.com/acme/shop.git?ref=dev'],
    ['a fragment', 'https://github.com/acme/shop.git#dev'],
    ['whitespace inside', 'https://github.com/acme/my shop.git'],
    ['a backslash', 'https://github.com\\acme\\shop.git'],
    ['a control character', 'https://github.com/acme/shop\u0007.git'],
    ['an option-like path segment', 'https://github.com/-oProxyCommand=x/shop.git'],
    ['an invalid host', 'https://exa_mple.com/acme/shop.git'],
    ['a URL over 2048 characters', `https://github.com/${'a'.repeat(2040)}`],
  ])('rejects a malformed URL: %s', (_case, input) => {
    expect(rejection(input)).toEqual(expect.any(String));
  });

  describe('SSH URLs (Issue #62)', () => {
    it.each([
      [
        'scp-like',
        'git@github.com:acme/shop.git',
        { host: 'github.com', port: 22 },
        'github.com/acme/shop',
      ],
      [
        'ssh://',
        'ssh://git@github.com/acme/shop.git',
        { host: 'github.com', port: 22 },
        'github.com/acme/shop',
      ],
      [
        'ssh:// on port 22',
        'ssh://git@GitHub.com:22/acme/shop',
        { host: 'github.com', port: 22 },
        'github.com/acme/shop',
      ],
      [
        'ssh:// on another port',
        'ssh://git@git.example.com:2222/acme/shop.git',
        { host: 'git.example.com', port: 2222 },
        'git.example.com:2222/acme/shop',
      ],
      [
        'ssh:// without a user',
        'ssh://git.example.com/srv/shop.git',
        { host: 'git.example.com', port: 22 },
        'git.example.com/srv/shop',
      ],
    ])('accepts a %s URL with its host and port', (_case, input, remote, identity) => {
      const url = RepositoryUrl.parse(`  ${input} `);

      expect(url.value).toBe(input);
      expect(url.ssh).toEqual(remote);
      expect(url.identity).toBe(identity);
    });

    it('marks an HTTPS URL as not SSH', () => {
      expect(RepositoryUrl.parse('https://github.com/acme/shop.git').ssh).toBeNull();
    });

    it.each([
      ['a password', 'ssh://git:secret@github.com/acme/shop.git'],
      ['an empty password', 'ssh://git:@github.com/acme/shop.git'],
      ['an option-like user', 'ssh://-oProxyCommand=x@github.com/acme/shop.git'],
      ['an option-like scp user', '-oProxyCommand=x@github.com:acme/shop.git'],
      ['an option-like scp host', 'git@-oProxyCommand=x:acme/shop.git'],
      ['an invalid host', 'git@exa_mple.com:acme/shop.git'],
      ['an option-like path segment', 'git@github.com:-acme/shop.git'],
      ['an option-like ssh:// path segment', 'ssh://git@github.com/-acme/shop.git'],
      ['a query', 'ssh://git@github.com/acme/shop.git?x=1'],
      ['no repository path', 'ssh://git@github.com/'],
    ])('rejects an SSH URL with %s', (_case, input) => {
      expect(rejection(input)).toEqual(expect.any(String));
    });

    it('stays linear on many colons in the authority (no polynomial backtracking)', () => {
      const started = performance.now();

      rejection(`ssh://${':'.repeat(1_000)}@x/${'a'.repeat(1_000)}`);
      rejection(`ssh://${':'.repeat(1_900)}`);
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  });

  it('accepts a file:// URL only under the test-only fixture-remote setting', () => {
    const url = RepositoryUrl.parse('file:///tmp/fixtures/shop.git', { allowFileRemotes: true });

    expect(url.identity).toBe('/tmp/fixtures/shop');
    expect(rejection('/tmp/fixtures/shop.git', { allowFileRemotes: true })).toMatch(/^Local paths/);
    expect(rejection('file://host/tmp/shop.git', { allowFileRemotes: true })).toMatch(/host/);
  });

  describe('IP-literal hosts under the address policy (Issue #69)', () => {
    const closed = { addressPolicy: { allowPrivate: false } };
    const open = { addressPolicy: { allowPrivate: true } };

    it.each([
      'https://169.254.169.254/latest/meta-data.git',
      'https://[fe80::1]/acme/shop.git',
      'https://[::ffff:169.254.169.254]/acme/shop.git',
      'https://100.100.100.200/acme/shop.git',
      'https://0.0.0.0/acme/shop.git',
      'https://224.0.0.1/acme/shop.git',
      'ssh://git@169.254.169.254/srv/repo.git',
      'git@169.254.169.254:acme/shop.git',
      'git@0xa9.0xfe.0xa9.0xfe:acme/shop.git',
      'ssh://git@2852039166/srv/repo.git',
    ])('never allows %s, even with the opt-in', (input) => {
      for (const options of [closed, open]) {
        expect(rejection(input, options)).toMatch(
          /^This address is not allowed: Studio never connects to link-local, cloud metadata/,
        );
      }
    });

    it.each([
      'https://127.0.0.1/acme/shop.git',
      'https://127.1/acme/shop.git',
      'https://0x7f.1/acme/shop.git',
      'https://2130706433/acme/shop.git',
      'https://[::1]/acme/shop.git',
      'https://[::ffff:127.0.0.1]/acme/shop.git',
      'https://10.0.0.5/acme/shop.git',
      'https://192.168.1.10:8443/acme/shop.git',
      'https://[fd12::1]/acme/shop.git',
      'ssh://git@0x7f.1:2222/srv/repo.git',
      'ssh://git@2130706433/srv/repo.git',
      'git@127.1:acme/shop.git',
      'git@10.0.0.5:acme/shop.git',
    ])('allows the loopback or private %s only with the opt-in', (input) => {
      expect(rejection(input, closed)).toBe(
        'This address is not allowed: loopback and private addresses need STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true on the Studio server.',
      );
      expect(() => RepositoryUrl.parse(input, open)).not.toThrow();
    });

    it.each(['ssh://git@256.1.1.1/srv/repo.git', 'git@1.2.3.4.5:acme/shop.git', 'git@08.1:a/b'])(
      'refuses %s, a numeric host that is no valid address',
      (input) => {
        expect(rejection(input, open)).toMatch(/^Enter a valid host name/);
      },
    );

    it('keeps the URL as entered and allows public addresses and host names', () => {
      expect(RepositoryUrl.parse('https://140.82.121.4/acme/shop.git', closed).value).toBe(
        'https://140.82.121.4/acme/shop.git',
      );
      expect(() => RepositoryUrl.parse('git@github.com:acme/shop.git', closed)).not.toThrow();
      expect(() => RepositoryUrl.parse('https://localhost/acme/shop.git', closed)).not.toThrow();
    });

    it('checks no address without a policy (reading a stored URL)', () => {
      expect(RepositoryUrl.parse('ssh://git@127.0.0.1:2222/srv/repo.git').ssh).toEqual({
        host: '127.0.0.1',
        port: 2222,
      });
    });
  });
});
