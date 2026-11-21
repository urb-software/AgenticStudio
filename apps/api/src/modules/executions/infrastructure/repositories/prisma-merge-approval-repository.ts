import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import { MergeApproval } from '../../domain/entities/merge-approval.js';
import { MERGE_APPROVAL_REFUSAL_CODES } from '../../domain/value-objects/merge-approval-refusal-code.js';
import { MERGE_APPROVAL_RESULTS } from '../../domain/value-objects/merge-approval-result.js';
import { MERGE_CHECK_STATES } from '../../domain/value-objects/merge-check-seen.js';
import { MERGE_METHODS } from '../../domain/value-objects/merge-method.js';
import type { MergeApprovalRepository } from '../../domain/repositories/merge-approval-repository.js';
import type { Executor } from './executor.js';

const checksSchema = z.array(z.object({ name: z.string(), state: z.enum(MERGE_CHECK_STATES) }));
const methodSchema = z.enum(MERGE_METHODS);
const resultSchema = z.enum(MERGE_APPROVAL_RESULTS);
const refusalCodeSchema = z.enum(MERGE_APPROVAL_REFUSAL_CODES);

type Row = NonNullable<Awaited<ReturnType<Executor['mergeApproval']['findFirst']>>>;

function toApproval(row: Row): MergeApproval {
  return MergeApproval.restore({
    id: row.id,
    runId: row.runId,
    approvedAt: row.approvedAt,
    approvedBy: 'operator',
    commit: row.commit,
    integrationBranch: row.integrationBranch,
    method: methodSchema.parse(row.method),
    checksSeen: checksSchema.parse(row.checksSeen),
    result: resultSchema.parse(row.result),
    refusal:
      row.refusalCode === null
        ? null
        : { code: refusalCodeSchema.parse(row.refusalCode), reason: row.refusalReason ?? '' },
    mergedCommit: row.mergedCommit,
    completedAt: row.completedAt,
    cloneFetchStartedAt: row.cloneFetchStartedAt,
  });
}

/**
 * The partial unique index `merge_approvals_one_pending_per_run_key` decides whether a Run
 * already has a pending approval, so concurrent requests cannot both store one.
 */
@Injectable()
export class PrismaMergeApprovalRepository implements MergeApprovalRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async findLatest(runId: string): Promise<MergeApproval | null> {
    const row = await this.db.mergeApproval.findFirst({
      where: { runId },
      orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
    });
    return row ? toApproval(row) : null;
  }

  async add(approval: MergeApproval): Promise<boolean> {
    const checks = JSON.stringify(
      approval.checksSeen.map((check) => ({ name: check.name, state: check.state })),
    );
    const inserted = await this.db.$executeRaw`
      INSERT INTO merge_approvals
        (id, run_id, approved_at, approved_by, "commit", integration_branch, method, checks_seen, result)
      VALUES (${approval.id}::uuid, ${approval.runId}::uuid, ${approval.approvedAt},
              ${approval.approvedBy}, ${approval.commit}, ${approval.integrationBranch},
              ${approval.method}, ${checks}::jsonb, 'pending')
      ON CONFLICT (run_id) WHERE result = 'pending' DO NOTHING`;
    return inserted === 1;
  }

  async finish(approval: MergeApproval): Promise<boolean> {
    const { count } = await this.db.mergeApproval.updateMany({
      where: { id: approval.id, result: 'pending' },
      data: {
        result: approval.result,
        refusalCode: approval.refusal?.code ?? null,
        refusalReason: approval.refusal?.reason ?? null,
        mergedCommit: approval.mergedCommit,
        completedAt: approval.completedAt,
      },
    });
    return count === 1;
  }

  async save(approval: MergeApproval): Promise<void> {
    await this.db.mergeApproval.update({
      where: { id: approval.id },
      data: {
        result: approval.result,
        refusalCode: approval.refusal?.code ?? null,
        refusalReason: approval.refusal?.reason ?? null,
        mergedCommit: approval.mergedCommit,
        completedAt: approval.completedAt,
        cloneFetchStartedAt: approval.cloneFetchStartedAt,
      },
    });
  }
}
