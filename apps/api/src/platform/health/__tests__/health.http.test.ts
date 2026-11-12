import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';

describe('GET /api/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The database client connects lazily, so this test needs no running PostgreSQL.
    app = await createApp({
      apiPort: 0,
      apiOrigin: 'http://localhost:3001',
      databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('responds 200 with a non-sensitive status body', async () => {
    const response = await request(app.getHttpServer()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('serves routes only under the /api prefix', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(404);
  });
});
