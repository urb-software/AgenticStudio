import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  knownHostName,
  parseKnownHosts,
  parseSshHostKey,
  SSH_HOST_KEY_TYPES,
} from '../ssh-known-hosts.js';

/** A synthetic public key blob of `type` (random bytes after the type), generated per run. */
function keyOfType(type: string): string {
  const name = Buffer.from(type, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return `${type} ${Buffer.concat([length, name, randomBytes(32)]).toString('base64')}`;
}

describe('knownHostName', () => {
  it('names port 22 by the host, other ports as [host]:port, in lower case', () => {
    expect(knownHostName('GitHub.com', 22)).toBe('github.com');
    expect(knownHostName('Git.Example.com', 2222)).toBe('[git.example.com]:2222');
  });
});

describe('parseSshHostKey', () => {
  it.each(SSH_HOST_KEY_TYPES)('accepts a %s key, dropping a comment', (type) => {
    const key = keyOfType(type);
    expect(parseSshHostKey(`  ${key} a comment `)).toBe(key);
  });

  it.each([
    ['an unknown type', keyOfType('ssh-dss')],
    ['a blob of another type', `ssh-rsa ${keyOfType('ssh-ed25519').split(' ')[1]}`],
    ['broken base64', 'ssh-ed25519 @@@'],
    ['an empty value', ''],
  ])('refuses %s', (_case, value) => {
    expect(parseSshHostKey(value)).toBeNull();
  });
});

describe('parseKnownHosts', () => {
  it('normalizes host names with the same naming as knownHostName', () => {
    const key = keyOfType('ssh-ed25519');
    expect(parseKnownHosts(`[GitHub.com]:22,[Git.Example.com]:2222 ${key}`).entries).toEqual([
      { hosts: [knownHostName('github.com', 22), knownHostName('git.example.com', 2222)], key },
    ]);
  });
});
