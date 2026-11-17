import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import type { FollowUpSource } from '../../domain/entities/run.js';
import { z } from 'zod';
import { PreparedFollowUp } from '../../domain/value-objects/prepared-follow-up.js';
import type { PreparedFollowUpRepository } from '../../domain/repositories/prepared-follow-up-repository.js';

/** What `items` holds, checked on read: the column is JSON, written by the preparation. */
const itemsSchema = z.array(
  z.object({
    name: z.string(),
    url: z.string(),
    logAvailable: z.boolean(),
    section: z.string(),
  }),
);

/** PostgreSQL adapter of {@link PreparedFollowUpRepository} (Issue #145): `run_prepared_follow_ups`. */
@Injectable()
export class PrismaPreparedFollowUpRepository implements PreparedFollowUpRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async find(runId: string): Promise<PreparedFollowUp | null> {
    const row = await this.db.runPreparedFollowUp.findUnique({ where: { runId } });
    if (!row) return null;
    return PreparedFollowUp.restore({
      // The CHECK constraint fixes the source; the items were written by the preparation.
      source: row.source as FollowUpSource,
      text: row.text,
      items: itemsSchema.parse(row.items),
    });
  }

  async discard(runId: string): Promise<void> {
    await this.db.runPreparedFollowUp.deleteMany({ where: { runId } });
  }
}
