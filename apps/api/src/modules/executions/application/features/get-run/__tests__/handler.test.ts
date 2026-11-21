import { describe, expect, it } from 'vitest';
import { inMemoryExecutions } from '../../../__tests__/in-memory-executions.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { deliveredRun, T0 } from '../../../../domain/repositories/__tests__/delivered-run.js';
import { InMemoryMergeApprovalRepository } from '../../../../domain/repositories/__tests__/in-memory-merge-approval-repository.js';
import { RetentionPolicy } from '../../../../domain/value-objects/retention-policy.js';
import type { MergeSettings } from '../../../ports/merge-settings.js';
import { MergeApproval } from '../../../../domain/entities/merge-approval.js';
import { GetRunHandler } from '../handler.js';

async function answerWith(
  settings: MergeSettings,
  approvals = new InMemoryMergeApprovalRepository(),
  seed?: (runId: string) => MergeApproval | undefined,
) {
  const runs = new InMemoryRunRepository();
  const run = await deliveredRun(runs);
  const seeded = seed?.(run.id);
  if (seeded) await approvals.add(seeded);
  const handler = new GetRunHandler(
    runs,
    { now: () => T0 },
    { record: () => undefined, latest: () => undefined, lastSeen: () => undefined },
    inMemoryExecutions(runs).preparedFollowUps,
    { seconds: 60 },
    RetentionPolicy.of({
      days: 7,
      maxPerProject: 10,
      openPullRequestIdleDays: 30,
      hoursAfterPullRequestEnd: 24,
    }),
    settings,
    approvals,
  );
  return handler.execute({ runId: run.id });
}

describe('GetRunHandler merge availability', () => {
  it('is available with the credential set for a GitHub remote', async () => {
    const answer = await answerWith({ configured: true, allowFileRemotes: false });
    expect(answer.merge).toEqual({ available: true });
  });

  it('says why merging is off while the credential is unset', async () => {
    const answer = await answerWith({ configured: false, allowFileRemotes: false });
    expect(answer.merge).toEqual({ available: false, reason: 'not_configured' });
  });
});

describe('GetRunHandler latest Merge approval', () => {
  const configured = { configured: true, allowFileRemotes: false };
  const approvalOf = (runId: string, approvedAt: Date) =>
    MergeApproval.approve(
      {
        id: 'e0000000-0000-4000-8000-000000000001',
        runId,
        commit: 'b'.repeat(40),
        integrationBranch: 'dev',
        method: 'squash',
        checksSeen: [{ name: 'ci', state: 'success' }],
      },
      approvedAt,
    );

  it('names the branch the pull request merges into', async () => {
    expect((await answerWith(configured)).integrationBranch).toBe('dev');
  });

  it('is null while the operator never approved a merge', async () => {
    expect((await answerWith(configured)).latestMergeApproval).toBeNull();
  });

  it('carries the newest approval', async () => {
    const answer = await answerWith(configured, new InMemoryMergeApprovalRepository(), (runId) =>
      approvalOf(runId, T0),
    );

    expect(answer.latestMergeApproval).toMatchObject({
      result: 'pending',
      commit: 'b'.repeat(40),
      checksSeen: [{ name: 'ci', state: 'success' }],
    });
  });

  it('reads a pending approval of a request that died as interrupted, without storing it', async () => {
    const approvals = new InMemoryMergeApprovalRepository();
    const answer = await answerWith(configured, approvals, (runId) =>
      approvalOf(runId, new Date(T0.getTime() - 3_600_000)),
    );

    expect(answer.latestMergeApproval).toMatchObject({
      result: 'not_carried_out',
      refusal: { code: 'interrupted' },
    });
    expect(approvals.approvals[0]!.result).toBe('pending');
  });
});
