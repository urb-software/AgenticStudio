import { createHash, createSecretKey, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWorkerToken } from '../worker-token.js';

// Issue #96: the worker token check. Throwaway tokens generated per run; none is committed.
const TOKEN = randomBytes(32).toString('base64');
const DIGEST = createSecretKey(createHash('sha256').update(TOKEN).digest());

describe('verifyWorkerToken', () => {
  it('accepts the configured token as a Bearer credential', () => {
    expect(verifyWorkerToken(DIGEST, `Bearer ${TOKEN}`)).toBe(true);
  });

  it('accepts the scheme in any case (RFC 9110 §11.1)', () => {
    expect(verifyWorkerToken(DIGEST, `bearer ${TOKEN}`)).toBe(true);
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
    expect(verifyWorkerToken(DIGEST, header)).toBe(false);
  });

  it('rejects everything when no token is configured (fail closed)', () => {
    expect(verifyWorkerToken(null, `Bearer ${TOKEN}`)).toBe(false);
    expect(verifyWorkerToken(null, undefined)).toBe(false);
  });
});
