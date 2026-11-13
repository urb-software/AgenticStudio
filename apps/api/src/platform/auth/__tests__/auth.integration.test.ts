import { startRedis, type TestService } from '@agentic-studio/testing';
import { Controller, Get, type INestApplication, type LoggerService, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../../__tests__/test-config.js';
import { AppModule } from '../../../app.module.js';
import { buildApp } from '../../../app.js';
import type { AppConfig } from '../../config/config.js';
import { problemDetailsSchema } from '../../http/problem-details.js';
import { hashPassword } from '../password.js';

// Throwaway test fixtures, never real credentials.
const PASSWORD = 'test-only operator password 7f3c';
const WRONG_PASSWORD = 'test-only wrong password 91ab';
const ORIGIN = 'http://localhost:4300';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Test-only route without @Public(): proves the guard denies by default. */
@Controller('__test__')
class ProtectedProbeController {
  @Get('protected')
  protectedRoute() {
    return { ok: true };
  }
}

/** Captures every log line at every level, so tests can assert nothing sensitive is logged. */
class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private capture(...parts: unknown[]) {
    this.lines.push(parts.map((part) => JSON.stringify(part) ?? String(part)).join(' '));
  }
  log = this.capture.bind(this);
  error = this.capture.bind(this);
  warn = this.capture.bind(this);
  debug = this.capture.bind(this);
  verbose = this.capture.bind(this);
  fatal = this.capture.bind(this);
}

async function startApp(config: AppConfig, logger: LoggerService): Promise<INestApplication> {
  @Module({ imports: [AppModule.register(config)], controllers: [ProtectedProbeController] })
  class TestRootModule {}
  const app = await buildApp(TestRootModule, { logger });
  await app.init();
  return app;
}

function sessionCookie(response: request.Response): string {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('studio_session='));
  if (!cookie) {
    throw new Error('expected a studio_session cookie');
  }
  return cookie;
}

/** `name=value` of a Set-Cookie header, as a browser would send it back. */
function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0]!;
}

function sessionId(setCookie: string): string {
  return cookiePair(setCookie).slice('studio_session='.length);
}

function expectProblem(response: request.Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
}

/** The body without its per-request correlation id. */
function stable(response: request.Response) {
  const body: Record<string, unknown> = { ...response.body };
  delete body.correlationId;
  return { status: response.status, contentType: response.headers['content-type'], body };
}

describe('operator authentication (Redis via Testcontainers)', () => {
  let redisService: TestService;
  let redis: Redis;
  let passwordHash: string;
  const logger = new CapturingLogger();
  let app: INestApplication;

  const login = (password: string, extra: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .set({ Origin: ORIGIN, ...extra })
      .send({ password });

  beforeAll(async () => {
    redisService = await startRedis();
    redis = new Redis(redisService.url);
    passwordHash = await hashPassword(PASSWORD);
    app = await startApp(
      testConfig({
        redisUrl: redisService.url,
        studioOrigin: ORIGIN,
        operatorPasswordHash: passwordHash,
      }),
      logger,
    );
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await redisService?.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  describe('login, session and logout', () => {
    it('logs in with the right password, sets the session cookie and reports the session', async () => {
      const response = await login(PASSWORD);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ authenticated: true });
      const cookie = sessionCookie(response);
      expect(cookie).toMatch(/; Path=\//);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; SameSite=Lax/);
      // http://localhost Studio origin: development cookie, not Secure, no __Host- prefix.
      expect(cookie).not.toMatch(/; Secure/);
      // ≥128 bits from a CSPRNG: 32 random bytes, base64url.
      expect(sessionId(cookie)).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const session = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', cookiePair(cookie));
      expect(session.status).toBe(200);
      expect(session.body).toEqual({ authenticated: true });
    });

    it('rejects a wrong password with 401 problem+json and no cookie', async () => {
      const response = await login(WRONG_PASSWORD);

      expectProblem(response, 401);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('gives identical responses for every authentication failure', async () => {
      const server = app.getHttpServer();
      const failures = await Promise.all([
        login(WRONG_PASSWORD),
        login(''.padEnd(10, 'x')),
        request(server).get('/api/auth/session'),
        request(server).get('/api/auth/session').set('Cookie', 'studio_session=forged'),
        request(server).get('/api/__test__/protected'),
      ]);

      const [first, ...rest] = failures.map(stable);
      expect(first).toMatchObject({ status: 401 });
      for (const other of rest) {
        expect(other).toEqual(first);
      }
    });

    it('returns 401 for the session without a cookie', async () => {
      expectProblem(await request(app.getHttpServer()).get('/api/auth/session'), 401);
    });

    it('rotates the session ID on login and invalidates the previous one', async () => {
      const first = sessionCookie(await login(PASSWORD));
      const second = sessionCookie(await login(PASSWORD, { Cookie: cookiePair(first) }));

      expect(sessionId(second)).not.toBe(sessionId(first));
      const server = app.getHttpServer();
      expectProblem(
        await request(server).get('/api/auth/session').set('Cookie', cookiePair(first)),
        401,
      );
      const current = await request(server)
        .get('/api/auth/session')
        .set('Cookie', cookiePair(second));
      expect(current.status).toBe(200);
    });

    it('logs out: invalidates the Redis session, clears the cookie, then 401', async () => {
      const cookie = cookiePair(sessionCookie(await login(PASSWORD)));
      const server = app.getHttpServer();

      const logout = await request(server)
        .post('/api/auth/logout')
        .set({ Origin: ORIGIN, Cookie: cookie });

      expect(logout.status).toBe(204);
      const cleared = sessionCookie(logout);
      expect(cleared).toMatch(/^studio_session=;/);
      expect(cleared).toMatch(/; Expires=Thu, 01 Jan 1970 00:00:00 GMT(;|$)/);
      expect(cleared).toMatch(/; Path=\/(;|$)/);
      expect(cleared).toMatch(/; HttpOnly(;|$)/);
      expect(cleared).toMatch(/; SameSite=Lax(;|$)/);
      expect(cleared).not.toMatch(/Domain=/i);
      expectProblem(await request(server).get('/api/auth/session').set('Cookie', cookie), 401);
      expectProblem(
        await request(server).post('/api/auth/logout').set({ Origin: ORIGIN, Cookie: cookie }),
        401,
      );
    });

    it('stores only a hash of the session ID in Redis, with a 12 h inactivity TTL', async () => {
      const id = sessionId(sessionCookie(await login(PASSWORD)));

      const keys = await redis.keys('*session*');
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain(id);
      const ttl = await redis.ttl(keys[0]!);
      expect(ttl).toBeGreaterThan(SESSION_TTL_SECONDS - 60);
      expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
      // The stored value carries nothing secret either.
      expect(await redis.get(keys[0]!)).not.toContain(id);
    });

    it('slides the inactivity TTL on each authenticated request', async () => {
      const cookie = cookiePair(sessionCookie(await login(PASSWORD)));
      const [key] = await redis.keys('*session*');
      await redis.expire(key!, 60);

      await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie);

      expect(await redis.ttl(key!)).toBeGreaterThan(SESSION_TTL_SECONDS - 60);
    });

    // #24 operator decision: a session ends 30 days after login, however active it is.
    describe('absolute lifetime of 30 days (fake clock)', () => {
      const LOGIN_TIME = new Date('2026-11-01T08:00:00.000Z');
      const DAY_MS = 24 * 60 * 60 * 1000;
      const at = (offsetMs: number) => vi.setSystemTime(LOGIN_TIME.getTime() + offsetMs);

      beforeEach(() => {
        // Only Date: Redis, Supertest and Argon2 keep real timers.
        vi.useFakeTimers({ toFake: ['Date'], now: LOGIN_TIME });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      const session = (cookie: string) =>
        request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie);

      it('keeps an active session valid until 30 days after login', async () => {
        const cookie = cookiePair(sessionCookie(await login(PASSWORD)));

        for (const day of [1, 10, 29]) {
          at(day * DAY_MS);
          expect((await session(cookie)).status).toBe(200);
        }
        at(30 * DAY_MS - 1000);
        expect((await session(cookie)).status).toBe(200);
      });

      it('rejects and deletes the session 30 days after login, despite activity', async () => {
        const cookie = cookiePair(sessionCookie(await login(PASSWORD)));
        at(29 * DAY_MS);
        expect((await session(cookie)).status).toBe(200);

        at(30 * DAY_MS);

        expectProblem(await session(cookie), 401);
        expect(await redis.keys('*session*')).toHaveLength(0);
        // Gone for good: an earlier clock does not revive it.
        at(DAY_MS);
        expectProblem(await session(cookie), 401);
      });

      it('applies the absolute lifetime on protected routes too', async () => {
        const cookie = cookiePair(sessionCookie(await login(PASSWORD)));
        at(31 * DAY_MS);

        expectProblem(
          await request(app.getHttpServer()).get('/api/__test__/protected').set('Cookie', cookie),
          401,
        );
      });

      // #33 review: a login on a fast clock must not stretch the lifetime once corrected.
      it('tolerates a login time up to 5 minutes in the future (clock skew)', async () => {
        const cookie = cookiePair(sessionCookie(await login(PASSWORD)));

        at(-5 * 60 * 1000);

        expect((await session(cookie)).status).toBe(200);
      });

      it('rejects and deletes a session whose login time is over 5 minutes in the future', async () => {
        const cookie = cookiePair(sessionCookie(await login(PASSWORD)));

        at(-5 * 60 * 1000 - 1000);

        expectProblem(await session(cookie), 401);
        expect(await redis.keys('*session*')).toHaveLength(0);
      });

      it.each(['{}', '{"createdAt":"not a date"}', 'null', 'not json'])(
        'fails closed on a stored record without a valid login time (%s)',
        async (stored) => {
          const cookie = cookiePair(sessionCookie(await login(PASSWORD)));
          const [key] = await redis.keys('*session*');
          await redis.set(key!, stored, 'KEEPTTL');

          expectProblem(await session(cookie), 401);
          expect(await redis.exists(key!)).toBe(0);
        },
      );

      it('gives a new login a fresh 30 days', async () => {
        const first = cookiePair(sessionCookie(await login(PASSWORD)));
        at(20 * DAY_MS);
        const second = cookiePair(sessionCookie(await login(PASSWORD, { Cookie: first })));

        at(45 * DAY_MS);

        expect((await session(second)).status).toBe(200);
      });
    });

    it('treats an expired session as no session', async () => {
      const cookie = cookiePair(sessionCookie(await login(PASSWORD)));
      await redis.flushdb();

      expectProblem(
        await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie),
        401,
      );
    });
  });

  describe('deny-by-default guard', () => {
    it('denies an unmarked route without a session', async () => {
      expectProblem(await request(app.getHttpServer()).get('/api/__test__/protected'), 401);
    });

    it('allows an unmarked route with a valid session', async () => {
      const cookie = cookiePair(sessionCookie(await login(PASSWORD)));

      const response = await request(app.getHttpServer())
        .get('/api/__test__/protected')
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
    });

    it('keeps the health route public', async () => {
      const response = await request(app.getHttpServer()).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('does not advertise the framework (no X-Powered-By)', async () => {
      const response = await request(app.getHttpServer()).get('/api/health');

      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('mutation Origin and content-type check', () => {
    const post = () => request(app.getHttpServer()).post('/api/auth/login');

    it.each([
      ['a foreign Origin', { Origin: 'https://evil.example' }],
      ['a different port', { Origin: 'http://localhost:4301' }],
      ['an opaque Origin', { Origin: 'null' }],
      ['no Origin and no Sec-Fetch-Site', {}],
      ['no Origin and a cross-site fetch', { 'Sec-Fetch-Site': 'cross-site' }],
      ['no Origin and a same-site fetch', { 'Sec-Fetch-Site': 'same-site' }],
      [
        'a foreign Origin claiming same-origin',
        { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' },
      ],
    ])('rejects a mutation with %s (403)', async (_case, headers) => {
      const response = await post().set(headers).send({ password: PASSWORD });

      expectProblem(response, 403);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('accepts a same-origin fetch without an Origin header', async () => {
      const response = await post()
        .set('Sec-Fetch-Site', 'same-origin')
        .send({ password: PASSWORD });

      expect(response.status).toBe(200);
    });

    it.each([
      ['text/plain', 'password=x'],
      ['application/x-www-form-urlencoded', 'password=x'],
      ['multipart/form-data; boundary=x', '--x--'],
    ])('rejects a non-JSON mutation (%s) with 415', async (contentType, body) => {
      const response = await post().set({ Origin: ORIGIN, 'Content-Type': contentType }).send(body);

      expectProblem(response, 415);
    });

    it('rejects a logout with a foreign Origin and keeps the session', async () => {
      const cookie = cookiePair(sessionCookie(await login(PASSWORD)));
      const server = app.getHttpServer();

      const response = await request(server)
        .post('/api/auth/logout')
        .set({ Origin: 'https://evil.example', Cookie: cookie });

      expectProblem(response, 403);
      expect((await request(server).get('/api/auth/session').set('Cookie', cookie)).status).toBe(
        200,
      );
    });

    it('does not apply the mutation check to safe methods', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/health')
        .set('Origin', 'https://evil.example');

      expect(response.status).toBe(200);
    });
  });

  describe('login rate limit', () => {
    it('answers the 6th failed login from one IP with 429 and Retry-After', async () => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expectProblem(await login(WRONG_PASSWORD), 401);
      }

      const blocked = await login(WRONG_PASSWORD);

      expectProblem(blocked, 429);
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    });

    it('blocks even the right password while the IP is limited', async () => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await login(WRONG_PASSWORD);
      }

      const response = await login(PASSWORD);

      expectProblem(response, 429);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('resets the IP counter after a successful login', async () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await login(WRONG_PASSWORD);
      }
      expect((await login(PASSWORD)).status).toBe(200);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expectProblem(await login(WRONG_PASSWORD), 401);
      }
    });

    it('cannot be bypassed with concurrent attempts', async () => {
      const responses = await Promise.all(Array.from({ length: 12 }, () => login(WRONG_PASSWORD)));

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    });

    it('ignores a spoofed X-Forwarded-For from an untrusted peer', async () => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await login(WRONG_PASSWORD, { 'X-Forwarded-For': `203.0.113.${attempt}` });
      }

      const response = await login(WRONG_PASSWORD, { 'X-Forwarded-For': '203.0.113.99' });

      expectProblem(response, 429);
    });
  });

  describe('no secrets in logs', () => {
    it('never logs the password, the hash or a session ID', async () => {
      const ids: string[] = [];
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        await login(WRONG_PASSWORD);
      }
      await redis.flushdb();
      const cookie = sessionCookie(await login(PASSWORD));
      ids.push(sessionId(cookie));
      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set({ Origin: ORIGIN, Cookie: cookiePair(cookie) });
      await login(PASSWORD, { Origin: 'https://evil.example' });

      expect(logger.lines.length).toBeGreaterThan(0);
      const logged = logger.lines.join('\n');
      const [, , , , salt = '', digest = ''] = passwordHash.split('$');
      for (const secret of [PASSWORD, WRONG_PASSWORD, passwordHash, salt, digest, ...ids]) {
        expect(secret.length).toBeGreaterThan(8);
        expect(logged).not.toContain(secret);
      }
      // The failures themselves are recorded, without the secrets.
      expect(logged).toMatch(/login failed/i);
      expect(logged).toMatch(/rate limit/i);
    });
  });
});

describe('client IP behind a trusted proxy', () => {
  let redisService: TestService;
  let redis: Redis;
  let app: INestApplication;

  const loginFrom = (forwardedFor: string) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .set({ Origin: ORIGIN, 'X-Forwarded-For': forwardedFor })
      .send({ password: WRONG_PASSWORD });

  beforeAll(async () => {
    redisService = await startRedis();
    redis = new Redis(redisService.url);
    app = await startApp(
      testConfig({
        redisUrl: redisService.url,
        studioOrigin: ORIGIN,
        operatorPasswordHash: await hashPassword(PASSWORD),
        // Supertest connects over loopback, so loopback plays the trusted proxy.
        apiTrustedProxies: ['127.0.0.1', '::1'],
      }),
      new CapturingLogger(),
    );
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await redisService?.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it('honours X-Forwarded-For from the trusted proxy: limits are per client IP', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await loginFrom('203.0.113.1');
    }
    expectProblem(await loginFrom('203.0.113.1'), 429);

    expectProblem(await loginFrom('203.0.113.2'), 401);
  });

  it('uses the right-most untrusted address, so a client cannot spoof its own entry', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await loginFrom(`198.51.100.${attempt}, 203.0.113.7`);
    }

    expectProblem(await loginFrom('198.51.100.99, 203.0.113.7'), 429);
  });

  // #24 operator decision: IPv6 counts per /64, IPv4-mapped IPv6 as its IPv4 address.
  it('limits IPv6 clients per /64, not per address', async () => {
    for (let host = 1; host <= 5; host += 1) {
      expectProblem(await loginFrom(`2001:db8:1:2::${host}`), 401);
    }

    expectProblem(await loginFrom('2001:db8:1:2:ffff::99'), 429);
    expectProblem(await loginFrom('2001:db8:1:3::1'), 401);
  });

  it('counts an IPv4-mapped IPv6 client as its IPv4 address', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await loginFrom(attempt % 2 === 0 ? '203.0.113.9' : '::ffff:203.0.113.9');
    }

    expectProblem(await loginFrom('203.0.113.9'), 429);
    expectProblem(await loginFrom('::ffff:203.0.113.9'), 429);
  });

  it('enforces a global ceiling of 50 failures per hour across IPs', async () => {
    for (let client = 1; client <= 10; client += 1) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expectProblem(await loginFrom(`203.0.113.${client}`), 401);
      }
    }

    const response = await loginFrom('203.0.113.200');

    expectProblem(response, 429);
    const retryAfter = Number(response.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(15 * 60);
    expect(retryAfter).toBeLessThanOrEqual(60 * 60);
  });

  // #24: the operator recovery documented in security.md §8 uses these exact keys.
  it('lifts the global lockout when the operator deletes the global failure counter', async () => {
    for (let client = 1; client <= 10; client += 1) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await loginFrom(`203.0.113.${client}`);
      }
    }
    expectProblem(await loginFrom('203.0.113.200'), 429);
    expect(await redis.get('auth:login-failures:global')).toBe('50');

    expect(await redis.del('auth:login-failures:global')).toBe(1);

    expectProblem(await loginFrom('203.0.113.200'), 401);
    // Per-IP counters are separate: a blocked IP stays blocked until its own key goes.
    expectProblem(await loginFrom('203.0.113.1'), 429);
    expect(await redis.del('auth:login-failures:ip:203.0.113.1')).toBe(1);
    expectProblem(await loginFrom('203.0.113.1'), 401);
  });
});

// #24: production cookie attributes behind an https Studio origin.
describe('session cookie for an https Studio origin', () => {
  const HTTPS_ORIGIN = 'https://studio.example.test';
  let redisService: TestService;
  let app: INestApplication;

  beforeAll(async () => {
    redisService = await startRedis();
    app = await startApp(
      testConfig({
        redisUrl: redisService.url,
        studioOrigin: HTTPS_ORIGIN,
        operatorPasswordHash: await hashPassword(PASSWORD),
      }),
      new CapturingLogger(),
    );
  });

  afterAll(async () => {
    await app?.close();
    await redisService?.stop();
  });

  function hostCookie(response: request.Response): string {
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    expect(cookies).toHaveLength(1);
    return cookies[0]!;
  }

  it('sets a __Host-studio_session cookie with Secure, Path=/ and no Domain', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', HTTPS_ORIGIN)
      .send({ password: PASSWORD });

    expect(response.status).toBe(200);
    const cookie = hostCookie(response);
    expect(cookie).toMatch(/^__Host-studio_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/; Secure(;|$)/);
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).toMatch(/; HttpOnly(;|$)/);
    expect(cookie).toMatch(/; SameSite=Lax(;|$)/);
    expect(cookie).not.toMatch(/Domain=/i);

    // The browser sends it back under the prefixed name only.
    const pair = cookie.split(';')[0]!;
    const server = app.getHttpServer();
    expect((await request(server).get('/api/auth/session').set('Cookie', pair)).status).toBe(200);
    const unprefixed = pair.replace(/^__Host-/, '');
    expectProblem(await request(server).get('/api/auth/session').set('Cookie', unprefixed), 401);

    // Logout clears it with the same attributes.
    const logout = await request(server)
      .post('/api/auth/logout')
      .set({ Origin: HTTPS_ORIGIN, Cookie: pair });
    expect(logout.status).toBe(204);
    const cleared = hostCookie(logout);
    expect(cleared).toMatch(/^__Host-studio_session=;/);
    expect(cleared).toMatch(/; Secure;/);
    expect(cleared).toMatch(/; Path=\/(;|$)/);
    expect(cleared).toMatch(/; HttpOnly(;|$)/);
    expect(cleared).toMatch(/; SameSite=Lax(;|$)/);
    expect(cleared).toMatch(/; Expires=Thu, 01 Jan 1970 00:00:00 GMT(;|$)/);
    expect(cleared).not.toMatch(/Domain=/i);
  });
});
