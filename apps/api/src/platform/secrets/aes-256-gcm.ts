import { createCipheriv, createDecipheriv, type KeyObject, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/** 96-bit nonce, the size GCM is specified for (NIST SP 800-38D). */
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface SealedValue {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

/** Encrypts `plaintext` under a fresh random nonce; `aad` is authenticated but not stored. */
export function seal(key: KeyObject, plaintext: string, aad: Buffer): SealedValue {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

/**
 * Decrypts and authenticates a sealed value; `undefined` when it does not authenticate
 * (wrong key, wrong AAD, tampered bytes, or a nonce or tag of the wrong length). The caller
 * picks the error, so no crypto error text travels further.
 */
export function open(key: KeyObject, sealed: SealedValue, aad: Buffer): string | undefined {
  if (sealed.nonce.length !== NONCE_BYTES || sealed.authTag.length !== AUTH_TAG_BYTES) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
