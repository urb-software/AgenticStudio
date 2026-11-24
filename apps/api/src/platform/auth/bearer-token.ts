import { createHash, type KeyObject, timingSafeEqual } from 'node:crypto';

const BEARER = /^Bearer +(\S+)$/i;

/**
 * Whether `Authorization` carries the worker token; `expected` is its SHA-256 digest, `null`
 * rejects everything. Digests have equal length, so the comparison is constant-time; never log.
 */
export function verifyWorkerToken(expected: KeyObject | null, authorization?: string): boolean {
  if (expected === null || authorization === undefined) return false;
  const token = BEARER.exec(authorization)?.[1];
  if (token === undefined) return false;
  const provided = createHash('sha256').update(token).digest();
  return timingSafeEqual(provided, expected.export());
}
