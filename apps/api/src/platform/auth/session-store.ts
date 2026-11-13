import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.js';

/** 12 hours of inactivity (security.md §8). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** 30 days after login, however active the session is (security.md §8, #24). */
export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How far in the future a login time may lie (clock skew). Beyond it, a session created
 * on a fast clock would outlive its absolute lifetime once the clock is corrected.
 */
export const SESSION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The stored record; `createdAt` is the login time. */
interface SessionRecord {
  createdAt: string;
}

/**
 * True when the record is well-formed, less than the absolute lifetime old, and its
 * login time is at most {@link SESSION_CLOCK_SKEW_MS} in the future.
 */
function isWithinLifetime(record: string, now: number): boolean {
  let createdAt: number;
  try {
    createdAt = Date.parse((JSON.parse(record) as Partial<SessionRecord>).createdAt ?? '');
  } catch {
    return false;
  }
  // NaN (missing or malformed) fails both comparisons, so it counts as expired.
  const age = now - createdAt;
  return age >= -SESSION_CLOCK_SKEW_MS && age < SESSION_ABSOLUTE_LIFETIME_MS;
}

/** 32 CSPRNG bytes (256 bits), base64url-encoded: 43 characters. */
const SESSION_ID_BYTES = 32;
const SESSION_ID_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/**
 * Only a SHA-256 of the session ID is used as the Redis key, so a Redis dump or
 * key listing does not reveal usable session IDs.
 */
function keyOf(sessionId: string): string {
  return `auth:session:${createHash('sha256').update(sessionId).digest('hex')}`;
}

/**
 * Server-side operator sessions in Redis, with a sliding inactivity TTL and an absolute
 * lifetime counted from login.
 */
@Injectable()
export class SessionStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Creates a new session and returns its opaque ID (for the cookie only; never log it). */
  async create(): Promise<string> {
    const sessionId = randomBytes(SESSION_ID_BYTES).toString('base64url');
    const record: SessionRecord = { createdAt: new Date().toISOString() };
    await this.redis.set(keyOf(sessionId), JSON.stringify(record), 'EX', SESSION_TTL_SECONDS);
    return sessionId;
  }

  /**
   * True when the session exists and is within its absolute lifetime; extends its
   * inactivity TTL in the same command. A session past its lifetime is deleted.
   */
  async touch(sessionId: string): Promise<boolean> {
    if (!SESSION_ID_FORMAT.test(sessionId)) {
      return false;
    }
    const key = keyOf(sessionId);
    const record = await this.redis.getex(key, 'EX', SESSION_TTL_SECONDS);
    if (record === null) {
      return false;
    }
    if (!isWithinLifetime(record, Date.now())) {
      await this.redis.del(key);
      return false;
    }
    return true;
  }

  async delete(sessionId: string): Promise<void> {
    if (SESSION_ID_FORMAT.test(sessionId)) {
      await this.redis.del(keyOf(sessionId));
    }
  }
}
