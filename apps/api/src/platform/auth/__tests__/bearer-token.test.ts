import { createHash, createSecretKey, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyBearerToken } from '../bearer-token.js';

// The bearer token check, shared by the worker and controller routes; throwaway tokens generated per run, none committed.
const TOKEN = randomBytes(32).toString('base64');
const DIGEST = createSecretKey(createHash('sha256').update(TOKEN).digest());

describe('verifyBearerToken', () => {
  it('accepts the configured token as a Bearer credential', () => {
    expect(verifyBearerToken(DIGEST, `Bearer ${TOKEN}`)).toBe(true);
  });

  it('accepts the scheme in any case (RFC 9110 §11.1)', () => {
    expect(verifyBearerToken(DIGEST, `bearer ${TOKEN}`)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['another token', `Bearer ${randomBytes(32).toString('base64')}`],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, -1)}`],
    ['the token with a suffix', `Bearer ${TOKEN}x`],
    ['the bare token without a scheme', TOKEN],
    ['another scheme', `Basic ${TOKEN}`],
    ['an empty credential', 'Bearer '],
  ])('rejects %s', (_case, header) => {
    expect(verifyBearerToken(DIGEST, header)).toBe(false);
  });

  it('rejects everything when no token is configured (fail closed)', () => {
    expect(verifyBearerToken(null, `Bearer ${TOKEN}`)).toBe(false);
    expect(verifyBearerToken(null, undefined)).toBe(false);
  });
});
