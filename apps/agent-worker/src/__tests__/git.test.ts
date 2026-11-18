import { describe, expect, it } from 'vitest';
import { GIT_HARDENING, maskCredentials } from '../git.js';

// What the worker's Git commands always carry, and what its log never shows.
describe('maskCredentials', () => {
  it.each([
    ['https://user:secret@host.test/repo.git', 'https://***@host.test/repo.git'],
    ['https://user:p@ss@host.test/repo.git', 'https://***@host.test/repo.git'],
    ['ssh://git@host.test/repo.git', 'ssh://***@host.test/repo.git'],
    [
      "fatal: unable to access 'https://x:y@h.test/r/': 403",
      "fatal: unable to access 'https://***@h.test/r/': 403",
    ],
  ])('masks the whole user information of %s', (text, masked) => {
    expect(maskCredentials(text)).toBe(masked);
  });

  it('leaves text without user information alone', () => {
    expect(maskCredentials('https://host.test/repo.git and agent@example.test')).toBe(
      'https://host.test/repo.git and agent@example.test',
    );
  });
});

describe('GIT_HARDENING', () => {
  it('runs no hooks, follows no redirect and accepts no packfile URIs', () => {
    expect(GIT_HARDENING).toEqual(
      expect.arrayContaining([
        'core.hooksPath=/dev/null',
        'http.followRedirects=false',
        'fetch.uriProtocols=',
        'submodule.recurse=false',
      ]),
    );
  });
});
