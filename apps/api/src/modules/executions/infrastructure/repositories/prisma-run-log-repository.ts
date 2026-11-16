import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import {
  planLogAppend,
  RUN_EVENT_KINDS,
  type RunEvent,
  type RunEventKind,
} from '../../domain/entities/run-event.js';
import { CLAIMED_RUN_STATES } from '../../domain/entities/run.js';
import type { RunLogRepository } from '../../domain/repositories/run-log-repository.js';

const EVENT_FIELDS = {
  seq: true,
  at: true,
  stepIndex: true,
  kind: true,
  text: true,
  truncated: true,
} as const;

/**
 * PostgreSQL adapter of {@link RunLogRepository} (Issue #99). An append locks the Run row, so
 * the holder check, the duplicate filter and the cap accounting (`runs.log_bytes`,
 * `runs.log_truncated`) see one consistent state, also against concurrent appends.
 */
@Injectable()
export class PrismaRunLogRepository implements RunLogRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async append(
    runId: string,
    workerId: string,
    events: readonly RunEvent[],
    maxBytes: number,
  ): Promise<number | null> {
    return this.db.$transaction(async (tx) => {
      const [run] = await tx.$queryRaw<{ log_bytes: number; log_truncated: boolean }[]>`
        SELECT log_bytes, log_truncated FROM runs
        WHERE id = ${runId}::uuid AND state IN (${Prisma.join([...CLAIMED_RUN_STATES])})
          AND claimed_by = ${workerId}::uuid
        FOR UPDATE`;
      if (!run) return null;
      const stored = await tx.runEvent.findMany({
        where: { runId, seq: { in: events.map((event) => event.seq) } },
        select: { seq: true },
      });
      const known = new Set(stored.map((event) => event.seq));
      const plan = planLogAppend(
        { bytes: run.log_bytes, truncated: run.log_truncated },
        events.filter((event) => !known.has(event.seq)),
        maxBytes,
      );
      if (plan.store.length === 0) return 0;
      await tx.runEvent.createMany({
        data: plan.store.map((event) => ({ runId, ...event })),
      });
      await tx.run.update({
        where: { id: runId },
        data: { logBytes: plan.state.bytes, logTruncated: plan.state.truncated },
      });
      return plan.store.length;
    });
  }

  async lastSeq(runId: string): Promise<number> {
    const { _max } = await this.db.runEvent.aggregate({ where: { runId }, _max: { seq: true } });
    return _max.seq ?? 0;
  }

  async listAfter(runId: string, after: number, limit: number): Promise<RunEvent[]> {
    const rows = await this.db.runEvent.findMany({
      where: { runId, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: limit,
      select: EVENT_FIELDS,
    });
    return rows.map((row) => {
      if (!(RUN_EVENT_KINDS as readonly string[]).includes(row.kind)) {
        throw new Error(`Unexpected run event kind in the database: ${row.kind}`);
      }
      return { ...row, kind: row.kind as RunEventKind };
    });
  }
}
