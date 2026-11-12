import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, startRedis, type TestService } from '@agentic-studio/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../app.js';
import type { AppConfig } from '../platform/config/config.js';
import { hashPassword } from '../platform/auth/password.js';
import { testConfig } from './test-config.js';

// Throwaway test fixtures, never real credentials.
const OPERATOR_PASSWORD = 'test-only operator password 5d21';
export const STUDIO_ORIGIN = 'http://localhost:4300';

/**
 * Real PostgreSQL (with the committed migrations applied) and Redis for HTTP tests
 * of the whole app. One set serves several app instances, so a test can restart the
 * app and see what an earlier instance persisted.
 */
export interface StudioServices {
  config: AppConfig;
  stop(): Promise<void>;
}

export async function startStudioServices(): Promise<StudioServices> {
  const started: TestService[] = [];
  try {
    const [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    started.push(postgres, redis);
    await deployMigrations(postgres.url);
    const config = testConfig({
      databaseUrl: postgres.url,
      redisUrl: redis.url,
      studioOrigin: STUDIO_ORIGIN,
      operatorPasswordHash: await hashPassword(OPERATOR_PASSWORD),
    });
    return { config, stop: () => stopAll(started) };
  } catch (error) {
    await stopAll(started);
    throw error;
  }
}

async function stopAll(services: TestService[]): Promise<void> {
  await Promise.all(services.map((service) => service.stop()));
}

/** Builds and initializes the production app (as `main.ts` does) without listening. */
export async function startStudioApp(config: AppConfig): Promise<INestApplication> {
  const app = await createApp(config);
  await app.init();
  return app;
}

/** Signs in as the operator; returns the `Cookie` header value a browser would send back. */
export async function signIn(app: INestApplication): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/login')
    .set('Origin', STUDIO_ORIGIN)
    .send({ password: OPERATOR_PASSWORD });
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((value) => value.startsWith('studio_session='));
  if (response.status !== 200 || !cookie) {
    throw new Error(`operator sign-in failed with status ${response.status}`);
  }
  return cookie.split(';')[0]!;
}
