import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.js';

/** Epic #8 decision 4: 5 failures per IP per 15 min, about 50 failures per hour overall. */
export const LOGIN_LIMITS = {
  perIp: { maxFailures: 5, windowMs: 15 * 60 * 1000 },
  global: { maxFailures: 50, windowMs: 60 * 60 * 1000 },
} as const;

// Atomically: refuse when a counter is at its limit (returning the longest wait), else
// reserve one failure on both counters. Reserving before the password check means
// concurrent attempts cannot all slip past a check-then-increment race.
const RESERVE = `
local ipCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local globalCount = tonumber(redis.call('GET', KEYS[2]) or '0')
local function remainingMs(key, windowMs)
  local ttl = redis.call('PTTL', key)
  if ttl > 0 then return ttl end
  return tonumber(windowMs)
end
local waitMs = 0
if ipCount >= tonumber(ARGV[1]) then
  waitMs = math.max(waitMs, remainingMs(KEYS[1], ARGV[2]))
end
if globalCount >= tonumber(ARGV[3]) then
  waitMs = math.max(waitMs, remainingMs(KEYS[2], ARGV[4]))
end
if waitMs > 0 then
  return waitMs
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2], 'NX')
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[4], 'NX')
return 0
`;

// A successful login is not a failure: reset the IP counter and return the global reservation.
const RELEASE = `
redis.call('DEL', KEYS[1])
if tonumber(redis.call('GET', KEYS[2]) or '0') > 0 then
  redis.call('DECR', KEYS[2])
end
return 0
`;

const GLOBAL_KEY = 'auth:login-failures:global';

function ipKey(clientIp: string): string {
  return `auth:login-failures:ip:${clientIp}`;
}

export type LoginAttempt = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Failed-login counters in Redis. Only failures count; success resets the IP counter. */
@Injectable()
export class LoginRateLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Call before verifying a password; the reservation stands unless {@link succeeded} is called. */
  async reserve(clientIp: string): Promise<LoginAttempt> {
    const { perIp, global } = LOGIN_LIMITS;
    const waitMs = Number(
      await this.redis.eval(
        RESERVE,
        2,
        ipKey(clientIp),
        GLOBAL_KEY,
        perIp.maxFailures,
        perIp.windowMs,
        global.maxFailures,
        global.windowMs,
      ),
    );
    return waitMs > 0
      ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
      : { allowed: true };
  }

  async succeeded(clientIp: string): Promise<void> {
    await this.redis.eval(RELEASE, 2, ipKey(clientIp), GLOBAL_KEY);
  }
}
