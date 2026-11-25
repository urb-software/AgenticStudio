import { createDatabaseClient, type DatabaseClient } from '@agentic-studio/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';
import { PrismaPublishLock } from '../prisma-publish-lock.js';

// The real advisory lock on PostgreSQL (Testcontainers): the one-publish-at-a-time guarantee.

describe('PrismaPublishLock (PostgreSQL via Testcontainers)', () => {
  let services: StudioServices;
  let db: DatabaseClient;
  let other: DatabaseClient;
  let lock: PrismaPublishLock;

  beforeAll(async () => {
    services = await startStudioServices();
    db = createDatabaseClient(services.config.databaseUrl);
    // A second client stands for a second API process.
    other = createDatabaseClient(services.config.databaseUrl);
    lock = new PrismaPublishLock(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await other?.$disconnect();
    await services?.stop();
  });

  it('runs the work and answers its value', async () => {
    await expect(lock.runExclusive(() => Promise.resolve(42))).resolves.toEqual({
      ran: true,
      value: 42,
    });
  });

  it('refuses a second publish at once while one runs, in this process and in another', async () => {
    let release: () => void = () => undefined;
    const held = lock.runExclusive(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('first');
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(lock.runExclusive(() => Promise.resolve('second'))).resolves.toEqual({
      ran: false,
    });
    await expect(
      new PrismaPublishLock(other).runExclusive(() => Promise.resolve('third')),
    ).resolves.toEqual({ ran: false });

    release();
    await expect(held).resolves.toEqual({ ran: true, value: 'first' });
  });

  it('releases the lock when the work fails, and when it ends', async () => {
    await expect(
      lock.runExclusive(() => Promise.reject(new Error('the publish failed'))),
    ).rejects.toThrow('the publish failed');

    await expect(lock.runExclusive(() => Promise.resolve('again'))).resolves.toEqual({
      ran: true,
      value: 'again',
    });
  });

  it('lets exactly one of simultaneous publishes run', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        lock.runExclusive(() => new Promise<string>((resolve) => setTimeout(resolve, 500, 'ran'))),
      ),
    );

    expect(results.filter((result) => result.ran)).toHaveLength(1);
  });
});
