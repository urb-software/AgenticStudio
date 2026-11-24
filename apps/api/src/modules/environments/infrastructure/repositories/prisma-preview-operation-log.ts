import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import type { PreviewOperationLog } from '../../application/ports/preview-operation-log.js';
import { PreviewLogCap } from '../../domain/value-objects/preview-log-cap.js';
import {
  PreviewLogLine,
  type PreviewLogStream,
} from '../../domain/value-objects/preview-log-line.js';
import { isPreviewOperationId } from '../../domain/value-objects/preview-operation-id.js';
import { type Executor, inTransaction } from './executor.js';

/**
 * An append locks the operation row, so the holder check, the duplicate filter and the cap
 * accounting see one consistent state, also against concurrent appends.
 */
@Injectable()
export class PrismaPreviewOperationLog implements PreviewOperationLog {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async page(
    operationId: string,
    after: number,
    limit: number,
  ): Promise<{ lines: PreviewLogLine[]; hasMore: boolean }> {
    if (!isPreviewOperationId(operationId)) return { lines: [], hasMore: false };
    const rows = await this.db.previewOperationLine.findMany({
      where: { operationId, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: limit + 1,
    });
    return {
      lines: rows.slice(0, limit).map((row) =>
        PreviewLogLine.restore({
          seq: row.seq,
          at: row.at,
          stream: row.stream as PreviewLogStream,
          text: row.text,
          truncated: row.truncated,
        }),
      ),
      hasMore: rows.length > limit,
    };
  }

  async append(
    operationId: string,
    controllerId: string,
    lines: readonly PreviewLogLine[],
    maxBytes: number,
  ): Promise<{ stored: number; truncated: boolean } | null> {
    if (!isPreviewOperationId(operationId)) return null;
    return inTransaction(this.db, async (tx) => {
      const [held] = await tx.$queryRaw<{ log_bytes: number; log_truncated: boolean }[]>`
        SELECT log_bytes, log_truncated FROM preview_operations
        WHERE id = ${operationId}::uuid AND status = 'claimed'
          AND claimed_by = ${controllerId}::uuid
        FOR UPDATE`;
      if (!held) return null;
      const stored = await tx.previewOperationLine.findMany({
        where: { operationId, seq: { in: lines.map((line) => line.seq) } },
        select: { seq: true },
      });
      const known = new Set(stored.map((line) => line.seq));
      const plan = PreviewLogCap.of({ bytes: held.log_bytes, truncated: held.log_truncated }).plan(
        lines.filter((line) => !known.has(line.seq)),
        maxBytes,
      );
      if (plan.store.length > 0) {
        await tx.previewOperationLine.createMany({
          data: plan.store.map((line) => ({
            operationId,
            seq: line.seq,
            at: line.at,
            stream: line.stream,
            text: line.text,
            truncated: line.truncated,
          })),
        });
        await tx.previewOperation.update({
          where: { id: operationId },
          data: { logBytes: plan.state.bytes, logTruncated: plan.state.truncated },
        });
      }
      return { stored: plan.store.length, truncated: plan.state.truncated };
    });
  }
}
