import { describe, expect, it } from 'vitest';
import { ScpLikeRemote } from '../scp-like-remote.js';

describe('ScpLikeRemote', () => {
  it('splits user, host and path', () => {
    const remote = ScpLikeRemote.of('git@GitHub.com:acme/shop.git');
    expect(remote).toMatchObject({ user: 'git', host: 'GitHub.com', path: 'acme/shop.git' });
    expect(remote?.ssh).toEqual({ host: 'github.com', port: 22 });
  });

  it('is null for text that is not in the short form', () => {
    for (const text of ['https://github.com/acme/shop', 'github.com:acme/shop', 'a@b', '']) {
      expect(ScpLikeRemote.of(text), text).toBeNull();
    }
  });

  it('notices a path segment that reads as a Git option', () => {
    expect(ScpLikeRemote.of('git@host:acme/--upload-pack=x')?.hasOptionLikeSegment).toBe(true);
    expect(ScpLikeRemote.of('git@host:acme/shop')?.hasOptionLikeSegment).toBe(false);
  });
});
