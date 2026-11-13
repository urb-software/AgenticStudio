import { describe, expect, it } from 'vitest';
import { GitRequestRejectedError } from '../../../../ports/repository-git.js';
import { parseRemoteUrl, type GitTransport } from '../remote-url.js';

const PRODUCTION: GitTransport[] = ['ssh', 'https'];

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'https'],
    ['https://git.example.test:8443/group/sub/repo', 'https'],
    ['ssh://git@github.com/owner/repo.git', 'ssh'],
    ['ssh://git@git.example.test:2222/srv/git/repo.git', 'ssh'],
    ['ssh://git.example.test/srv/git/repo.git', 'ssh'],
    ['git@github.com:owner/repo.git', 'ssh'],
  ])('accepts %s as %s', (url, transport) => {
    expect(parseRemoteUrl(url, PRODUCTION)).toEqual({ transport, url });
  });

  it.each([
    ['file:///srv/git/repo.git', 'file transport'],
    ['git://github.com/owner/repo.git', 'git transport'],
    ['http://github.com/owner/repo.git', 'plain http'],
    ['ftp://github.com/owner/repo.git', 'ftp'],
    ['ext::sh -c touch% /tmp/pwned', 'ext transport'],
    ['fd::17', 'fd transport'],
    ['/srv/git/repo.git', 'absolute local path'],
    ['./repo.git', 'relative local path'],
    ['../repo.git', 'parent local path'],
    ['repo.git', 'bare local name'],
    ['C:\\repos\\repo.git', 'Windows path'],
    ['https://user:secret@github.com/owner/repo.git', 'https user and password'],
    ['https://ghp_token@github.com/owner/repo.git', 'https token as user'],
    ['ssh://git:secret@github.com/owner/repo.git', 'ssh password'],
    ['https://github.com/owner/repo.git?token=x', 'query string'],
    ['https://github.com/owner/repo.git#frag', 'fragment'],
    ['ssh://-oProxyCommand=touch%20pwned/repo', 'option-like host'],
    ['-oProxyCommand=touch pwned', 'option-like value'],
    ['-u@host:repo', 'option-like scp user'],
    ['git@-oProxyCommand=x:repo', 'option-like scp host'],
    ['git@github.com:-repo', 'option-like scp path'],
    ['https://github.com/-repo', 'option-like path segment'],
    ['https://github.com', 'missing path'],
    ['https://github.com/owner/repo .git', 'whitespace'],
    ['https://github.com/owner/repo\n.git', 'newline'],
    ['', 'empty'],
  ])('rejects %s (%s) before Git starts', (url) => {
    expect(() => parseRemoteUrl(url, PRODUCTION)).toThrow(GitRequestRejectedError);
  });

  it('accepts file URLs only when the allowed set includes file', () => {
    expect(parseRemoteUrl('file:///tmp/fixture.git', ['ssh', 'https', 'file'])).toEqual({
      transport: 'file',
      url: 'file:///tmp/fixture.git',
    });
    expect(() => parseRemoteUrl('file://host/tmp/fixture.git', ['file'])).toThrow(
      GitRequestRejectedError,
    );
    expect(() => parseRemoteUrl('/tmp/fixture.git', ['ssh', 'https', 'file'])).toThrow(
      GitRequestRejectedError,
    );
  });

  it('honours a narrower allowed set', () => {
    expect(() => parseRemoteUrl('git@github.com:owner/repo.git', ['https'])).toThrow(
      GitRequestRejectedError,
    );
    expect(() => parseRemoteUrl('https://github.com/owner/repo.git', ['ssh'])).toThrow(
      GitRequestRejectedError,
    );
  });

  it('does not echo the URL (which may hold a credential) in the error', () => {
    const error = (() => {
      try {
        parseRemoteUrl('https://user:do-not-leak@github.com/o/r.git', PRODUCTION);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('expected a rejection');
    })();
    expect(error.message).not.toContain('do-not-leak');
  });
});
