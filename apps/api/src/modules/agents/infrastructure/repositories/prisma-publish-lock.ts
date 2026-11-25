import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import type { PublishLock } from '../../application/ports/publish-lock.js';

/** The key of the advisory lock: one publish at a time, across API processes. */
const LOCK_NAME = 'studio.agents.publish';

/** Longer than a push may take (the Git adapter bounds it at two minutes), so the lock never ends first. */
const PUBLISH_TRANSACTION = { maxWait: 10_000, timeout: 5 * 60 * 1000 } as const;

/**
 * PostgreSQL adapter of {@link PublishLock}: a transaction-scoped advisory lock taken without
 * waiting. The transaction holds the lock for the whole publish and releases it at commit or
 * rollback, so a crash of the process frees it too.
 */
@Injectable()
export class PrismaPublishLock implements PublishLock {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async runExclusive<T>(work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    return this.db.$transaction(async (tx) => {
      const [taken] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_NAME})) AS locked`;
      if (!taken?.locked) return { ran: false as const };
      return { ran: true as const, value: await work() };
    }, PUBLISH_TRANSACTION);
  }
}
