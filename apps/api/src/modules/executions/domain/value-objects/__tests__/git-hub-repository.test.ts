import { describe, expect, it } from 'vitest';
import { GitHubRepository } from '../git-hub-repository.js';

const names = (remote: string, allowFileRemotes = false) =>
  GitHubRepository.fromRemote(remote, { allowFileRemotes })?.fullName ?? null;

describe('GitHubRepository.fromRemote', () => {
  it.each([
    'https://github.com/acme/shop',
    'https://github.com/acme/shop.git',
    'https://GitHub.com/acme/shop/',
    'git@github.com:acme/shop.git',
    'git@github.com:acme/shop',
    'ssh://git@github.com/acme/shop.git',
  ])('names acme/shop for %s', (remote) => {
    expect(names(remote)).toBe('acme/shop');
  });

  it.each([
    'https://gitlab.com/acme/shop.git',
    'https://github.com.evil.test/acme/shop.git',
    'https://user:pw@github.com/acme/shop.git',
    'https://github.com:8443/acme/shop.git',
    'https://github.com/acme/shop.git?x=1',
    'https://github.com/acme',
    'https://github.com/acme/shop/extra',
    'ssh://other@github.com/acme/shop.git',
    'http://github.com/acme/shop.git',
    'git@gitlab.com:acme/shop.git',
    'https://github.com/-bad/shop',
    'https://github.com/acme/..',
    'file:///srv/git/acme/shop.git',
    'not a url',
    '',
  ])('names no repository for %s', (remote) => {
    expect(names(remote)).toBeNull();
  });

  it('names a file remote by its last two parts only when file remotes are allowed', () => {
    expect(names('file:///srv/git/acme/shop.git', true)).toBe('acme/shop');
    expect(names('file:///shop.git', true)).toBeNull();
  });
});
