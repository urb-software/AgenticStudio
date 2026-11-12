import { type Algorithm, hash, verify } from '@node-rs/argon2';
import { ARGON2ID_BASELINE } from '../config/config.js';

// `Algorithm` is an ambient const enum, which isolatedModules cannot inline.
const ARGON2ID = 2 as Algorithm;

/** Hashes a password as an Argon2id PHC string at the OWASP baseline (security.md §8). */
export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID, ...ARGON2ID_BASELINE });
}

/**
 * Verifies a password against an Argon2id PHC string (constant-time comparison in
 * the binding). A malformed hash is a mismatch, never an error that could leak it.
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
