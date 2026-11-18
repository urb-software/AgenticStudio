import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import { PreparedFollowUp } from '../../domain/entities/prepared-follow-up.js';
import type { PreparedFollowUpRepository } from '../../domain/repositories/prepared-follow-up-repository.js';
import type { FollowUpSource } from '../../domain/value-objects/follow-up-source.js';
import type { Executor } from './executor.js';

const itemsSchema = z.array(
  z.object({
    name: z.string(),
    url: z.string(),
    logAvailable: z.boolean(),
    section: z.string(),
  }),
);

@Injectable()
export class PrismaPreparedFollowUpRepository implements PreparedFollowUpRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

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

  async findRunIdsAmong(runIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (runIds.length === 0) return new Set();
    const rows = await this.db.runPreparedFollowUp.findMany({
      where: { runId: { in: [...runIds] } },
      select: { runId: true },
    });
    return new Set(rows.map((row) => row.runId));
  }

  async replace(runId: string, draft: PreparedFollowUp, now: Date): Promise<void> {
    const items = draft.items as unknown as Prisma.InputJsonValue;
    await this.db.runPreparedFollowUp.upsert({
      where: { runId },
      create: { runId, source: draft.source, text: draft.text, items, createdAt: now },
      update: { source: draft.source, text: draft.text, items, createdAt: now },
    });
  }

  async discard(runId: string, source?: FollowUpSource): Promise<void> {
    await this.db.runPreparedFollowUp.deleteMany({
      where: source === undefined ? { runId } : { runId, source },
    });
  }
}
