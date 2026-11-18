import { describe, expect, it } from 'vitest';
import { KnownHostName } from '../known-host-name.js';

describe('KnownHostName', () => {
  it('is the lower-case host, with the port in brackets unless it is 22', () => {
    expect(KnownHostName.of('git@GitHub.com:acme/shop.git')?.value).toBe('github.com');
    expect(KnownHostName.of('ssh://git@git.example.com:2222/a/b.git')?.value).toBe(
      '[git.example.com]:2222',
    );
  });

  it('is null for an https URL or text that is no URL', () => {
    expect(KnownHostName.of('https://github.com/acme/shop.git')).toBeNull();
    expect(KnownHostName.of('not a url')).toBeNull();
  });
});
