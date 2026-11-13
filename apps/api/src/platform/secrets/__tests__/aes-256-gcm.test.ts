import { createSecretKey, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seal, unseal } from '../aes-256-gcm.js';

// Issue #57 review F1: the sealed parts read back from the database are untrusted. A tag or
// nonce of the wrong length must fail closed. Without the length checks Node accepts a
// truncated GCM tag (as short as 4 bytes), which would cut forgery resistance to 2^32.

const KEY = createSecretKey(randomBytes(32));
const AAD = Buffer.from('9b2f6c1e-4d0a-4f7b-8e3c-2a1d5f6b7c8d', 'utf8');
const VALUE = 'test-only throwaway value ünïcødé';

describe('AES-256-GCM seal/unseal', () => {
  it('round-trips a value under the same key and AAD', () => {
    expect(unseal(KEY, seal(KEY, VALUE, AAD), AAD)).toBe(VALUE);
  });

  it.each([0, 4, 12])('fails closed on a stored tag truncated to %i bytes', (length) => {
    const sealed = seal(KEY, VALUE, AAD);

    expect(unseal(KEY, { ...sealed, authTag: sealed.authTag.subarray(0, length) }, AAD)).toBe(
      undefined,
    );
  });

  it('fails closed on a stored tag longer than 16 bytes', () => {
    const sealed = seal(KEY, VALUE, AAD);

    expect(
      unseal(KEY, { ...sealed, authTag: Buffer.concat([sealed.authTag, Buffer.alloc(1)]) }, AAD),
    ).toBe(undefined);
  });

  it.each([8, 16])('fails closed on a stored nonce of %i bytes', (length) => {
    const sealed = seal(KEY, VALUE, AAD);
    const nonce = Buffer.concat([sealed.nonce, Buffer.alloc(4)]).subarray(0, length);

    expect(unseal(KEY, { ...sealed, nonce }, AAD)).toBe(undefined);
  });
});
