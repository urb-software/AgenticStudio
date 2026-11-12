import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.js';

/** 12 hours of inactivity (security.md §8). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

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

/** Server-side operator sessions in Redis, with a sliding inactivity TTL. */
@Injectable()
export class SessionStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Creates a new session and returns its opaque ID (for the cookie only; never log it). */
  async create(): Promise<string> {
    const sessionId = randomBytes(SESSION_ID_BYTES).toString('base64url');
    const record = JSON.stringify({ createdAt: new Date().toISOString() });
    await this.redis.set(keyOf(sessionId), record, 'EX', SESSION_TTL_SECONDS);
    return sessionId;
  }

  /** True when the session exists; extends its inactivity TTL in the same command. */
  async touch(sessionId: string): Promise<boolean> {
    if (!SESSION_ID_FORMAT.test(sessionId)) {
      return false;
    }
    const record = await this.redis.getex(keyOf(sessionId), 'EX', SESSION_TTL_SECONDS);
    return record !== null;
  }

  async delete(sessionId: string): Promise<void> {
    if (SESSION_ID_FORMAT.test(sessionId)) {
      await this.redis.del(keyOf(sessionId));
    }
  }
}
