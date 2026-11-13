import { startRedis, type TestService } from '@agentic-studio/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../../../__tests__/test-config.js';
import { createApp } from '../../../app.js';

describe('GET /api/health', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('with Redis reachable', () => {
    let redis: TestService;

    beforeAll(async () => {
      redis = await startRedis();
    });

    afterAll(async () => {
      await redis?.stop();
    });

    it('responds 200 with a non-sensitive status body', async () => {
      // The database client connects lazily, so this test needs no running PostgreSQL.
      app = await createApp(testConfig({ redisUrl: redis.url }));
      await app.init();

      const response = await request(app.getHttpServer()).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('serves routes only under the /api prefix', async () => {
      app = await createApp(testConfig({ redisUrl: redis.url }));
      await app.init();

      const response = await request(app.getHttpServer()).get('/health');

      expect(response.status).toBe(404);
    });
  });

  it("responds 503 without naming the dependency when the queue's Redis is unreachable", async () => {
    app = await createApp(testConfig({ redisUrl: 'redis://127.0.0.1:1' }));
    await app.init();

    const response = await request(app.getHttpServer()).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 503, title: 'Service Unavailable' });
    expect(JSON.stringify(response.body)).not.toMatch(/redis|6379|127\.0\.0\.1|ECONNREFUSED/i);
  });
});
