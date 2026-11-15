import { createHash, type KeyObject, timingSafeEqual } from 'node:crypto';

const BEARER = /^Bearer +(\S+)$/i;

/**
 * Whether an `Authorization` header carries the agent worker token (Issue #96). `expected` is
 * the SHA-256 digest of the configured token (`AppConfig.workerToken`); `null` (no token
 * configured) rejects everything. The digests have equal length whatever was sent, so the
 * comparison is constant-time. Neither the header nor the token is ever logged.
 */
export function verifyWorkerToken(expected: KeyObject | null, authorization?: string): boolean {
  if (expected === null || authorization === undefined) return false;
  const token = BEARER.exec(authorization)?.[1];
  if (token === undefined) return false;
  const provided = createHash('sha256').update(token).digest();
  return timingSafeEqual(provided, expected.export());
}
