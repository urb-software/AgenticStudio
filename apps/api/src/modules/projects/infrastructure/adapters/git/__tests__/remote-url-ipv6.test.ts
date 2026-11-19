import { describe, expect, it } from 'vitest';
import { GitRequestRejectedError } from '../../../../application/ports/repository-git.js';
import { parseRemoteUrl } from '../remote-url.js';

describe('parseRemoteUrl with an IPv6 literal in an ssh URL', () => {
  it('accepts the literal as the host', () => {
    expect(parseRemoteUrl('ssh://git@[::1]:2222/srv/repo.git', ['ssh'])).toEqual({
      transport: 'ssh',
      url: 'ssh://git@[::1]:2222/srv/repo.git',
    });
  });

  it.each([
    'ssh://[::1]@host.example.test/r',
    'ssh://a[::1]/r',
    'ssh://[::1]x/r',
    'ssh://[::1].evil.com/r',
  ])('refuses %s, where Git would read another host', (input) => {
    expect(() => parseRemoteUrl(input, ['ssh'])).toThrow(GitRequestRejectedError);
  });
});
