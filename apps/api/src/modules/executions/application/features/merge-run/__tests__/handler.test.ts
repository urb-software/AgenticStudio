import { beforeEach, describe, expect, it } from 'vitest';
import { MergeApproval } from '../../../../domain/entities/merge-approval.js';
import { RunMergeReview } from '../../../../domain/entities/run-merge-review.js';
import { MergeRefusedError } from '../../../../domain/errors/merge-approval-errors.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import {
  deliveredRun,
  PROJECT,
  T0,
} from '../../../../domain/repositories/__tests__/delivered-run.js';
import { InMemoryMergeApprovalRepository } from '../../../../domain/repositories/__tests__/in-memory-merge-approval-repository.js';
import { InMemoryRunMergeReviewRepository } from '../../../../domain/repositories/__tests__/in-memory-run-merge-review-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { LogRedaction } from '../../../../domain/value-objects/log-redaction.js';
import type {
  IntegrationFetchResult,
  RunIntegrationFetches,
} from '../../../../../projects/contracts/index.js';
import { InMemoryMergeHost, MERGED_COMMIT } from '../../../ports/__tests__/in-memory-merge-host.js';
import type { MergeSettings } from '../../../ports/merge-settings.js';
import { MergeRunHandler } from '../handler.js';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const COMMIT = 'b'.repeat(40);
const NOW = new Date(T0.getTime() + 600_000);
const LIMITS = { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 };

function readyReview(runId: string, runCommit = COMMIT): RunMergeReview {
  return RunMergeReview.request(runId, T0).ready(
    {
      runCommit,
      integrationCommit: 'a'.repeat(40),
      files: [{ path: 'src/a.txt', status: 'added', patch: '+a\n', cut: false }],
      truncated: false,
      redaction: LogRedaction.NONE,
      limits: {
        filesMax: 10,
        filePatchMaxBytes: 1000,
        patchMaxBytes: 10_000,
        totalMaxBytes: 10_000,
      },
    },
    T0,
  );
}

describe('MergeRunHandler', () => {
  let runs: InMemoryRunRepository;
  let approvals: InMemoryMergeApprovalRepository;
  let reviews: InMemoryRunMergeReviewRepository;
  let host: InMemoryMergeHost;
  let settings: MergeSettings;
  let now: Date;
  let fetched: string[];
  let fetchAnswer: 'started' | 'not_started' | 'throws';
  let handler: MergeRunHandler;

  const fetches: RunIntegrationFetches = {
    fetchIntegrationBranch: (projectId): Promise<IntegrationFetchResult> => {
      fetched.push(projectId);
      if (fetchAnswer === 'throws') return Promise.reject(new Error('queue down'));
      return Promise.resolve({ status: fetchAnswer });
    },
  };

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    approvals = new InMemoryMergeApprovalRepository();
    reviews = new InMemoryRunMergeReviewRepository();
    host = new InMemoryMergeHost();
    settings = { configured: true, allowFileRemotes: false };
    now = NOW;
    fetched = [];
    fetchAnswer = 'started';
    handler = new MergeRunHandler(
      runs,
      approvals,
      reviews,
      host,
      settings,
      { now: () => now },
      fetches,
    );
    await deliveredRun(runs, { id: RUN_ID });
    reviews.reviews.set(RUN_ID, readyReview(RUN_ID));
    host.setPullRequest({ headSha: COMMIT, draft: true });
  });

  const methods = () => host.calls.map((call) => call.method);
  const stored = async () => (await runs.findById(RUN_ID))!;
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MergeRefusedError);
    return error as MergeRefusedError;
  };
  const refused = async (reason: string, commit = COMMIT) => {
    const error = await refusal(handler.execute({ runId: RUN_ID, commit }));
    expect(error.reason).toBe(reason);
    return error;
  };
  const expectNothingStoredOrCalledOnTheHost = () => {
    expect(approvals.approvals).toEqual([]);
    expect(
      methods().filter((method) => ['markReady', 'approve', 'merge'].includes(method)),
    ).toEqual([]);
  };

  describe('carrying out the merge', () => {
    it('reads the pull request and its checks, then marks it ready, approves, merges pinned to the commit and cleans up', async () => {
      host.setChecks([{ name: 'ci', state: 'success' }]);

      const result = await handler.execute({ runId: RUN_ID, commit: COMMIT });

      expect(methods()).toEqual([
        'readPullRequest',
        'readChecks',
        'markReady',
        'approve',
        'merge',
        'deleteRunBranch',
      ]);
      expect(host.calls[1]).toMatchObject({ method: 'readChecks', sha: COMMIT });
      expect(host.calls[3]).toMatchObject({ method: 'approve', sha: COMMIT });
      expect(host.calls[4]!.merge).toEqual({
        sha: COMMIT,
        method: 'squash',
        title: 'Add a health check',
        message: 'Adds GET /health.',
      });
      expect(host.calls[4]!.scope).toEqual({
        remoteUrl: 'https://github.com/acme/shop.git',
        runId: RUN_ID,
        integrationBranch: 'dev',
        runBranch: 'agent/x-r0b8e5c2d',
        pullRequestNumber: 7,
      });
      expect(fetched).toEqual([PROJECT]);
      expect(result).toMatchObject({
        approval: {
          approvedAt: NOW,
          approvedBy: 'operator',
          commit: COMMIT,
          integrationBranch: 'dev',
          method: 'squash',
          checksSeen: [{ name: 'ci', state: 'success' }],
          result: 'carried_out',
          refusal: null,
          mergedCommit: MERGED_COMMIT,
          completedAt: NOW,
          cloneFetchStartedAt: NOW,
        },
        runBranchDeletedAt: NOW,
        runBranchDeletionFailure: null,
      });
      expect((await stored()).retentionFacts()).toMatchObject({ pullRequestState: 'merged' });
    });

    it('does not mark a pull request ready that is not a draft', async () => {
      host.setPullRequest({ draft: false });

      await handler.execute({ runId: RUN_ID, commit: COMMIT });

      expect(methods()).not.toContain('markReady');
    });

    it('merges when the commit has no checks at all, and when its checks are neutral or skipped', async () => {
      await expect(handler.execute({ runId: RUN_ID, commit: COMMIT })).resolves.toMatchObject({
        approval: { result: 'carried_out', checksSeen: [] },
      });
    });

    it('accepts the commit in another letter case', async () => {
      await expect(
        handler.execute({ runId: RUN_ID, commit: COMMIT.toUpperCase() }),
      ).resolves.toMatchObject({ approval: { result: 'carried_out' } });
    });

    it('answers 404 for an unknown or malformed run id', async () => {
      await expect(handler.execute({ runId: 'nope', commit: COMMIT })).rejects.toBeInstanceOf(
        RunNotFoundError,
      );
    });
  });

  describe('refusals made by Studio before any host call', () => {
    it.each([
      ['merge_unavailable', () => void (settings.configured = false), COMMIT],
      ['review_out_of_date', () => void reviews.reviews.delete(RUN_ID), COMMIT],
      [
        'review_out_of_date',
        () => void reviews.reviews.set(RUN_ID, RunMergeReview.request(RUN_ID, NOW)),
        COMMIT,
      ],
      ['commit_moved', () => undefined, 'c'.repeat(40)],
    ])('refuses with %s and records nothing', async (reason, arrange, commit) => {
      arrange();

      await refused(reason, commit);

      expect(host.calls).toEqual([]);
      expect(approvals.approvals).toEqual([]);
    });

    it('refuses a review of an earlier commit than the Run branch has now', async () => {
      const run = runs.runs.find((candidate) => candidate.id === RUN_ID)!;
      run.pullRequestStatus = {
        ...run.pullRequestStatus,
        state: 'open',
        refreshedAt: NOW,
        checks: { commit: 'd'.repeat(40), checks: [] },
      };

      await refused('review_out_of_date');

      expect(host.calls).toEqual([]);
    });

    it('refuses an active Run', async () => {
      const active = await runs.start({
        id: '1b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
        projectId: PROJECT,
        provider: 'claude_code',
        task: 'y',
        startCommit: 'a',
        remoteUrl: 'https://github.com/acme/shop.git',
        limits: LIMITS,
        integrationBranch: 'dev',
      });

      const error = await refusal(handler.execute({ runId: active.id, commit: COMMIT }));

      expect(error.reason).toBe('run_active');
      expect(host.calls).toEqual([]);
    });

    it('refuses a Run without a pull request', async () => {
      const bare = await deliveredRun(runs, {
        delivered: false,
        id: '2b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
      });
      reviews.reviews.set(bare.id, readyReview(bare.id));

      const error = await refusal(handler.execute({ runId: bare.id, commit: COMMIT }));

      expect(error.reason).toBe('pull_request_not_open');
      expect(host.calls).toEqual([]);
    });
  });

  describe('refusals from what Studio reads on the Git host', () => {
    it.each([
      ['a failing check', [{ name: 'ci', state: 'failure' as const }], {}, 'checks_failing'],
      ['a running check', [{ name: 'ci', state: 'pending' as const }], {}, 'checks_running'],
      ['a conflict', [], { mergeable: false }, 'conflicting'],
      ['a dirty merge state', [], { mergeableState: 'dirty' }, 'conflicting'],
      ['a mergeability the host has not computed', [], { mergeable: null }, 'checks_running'],
      ['a head that moved', [], { headSha: 'c'.repeat(40) }, 'commit_moved'],
    ])('refuses %s and records nothing', async (_name, checks, pullRequest, reason) => {
      host.setChecks(checks);
      host.setPullRequest(pullRequest);

      await refused(reason);

      expectNothingStoredOrCalledOnTheHost();
    });

    it('lets a failing check outrank a conflict, and neutral checks pass', async () => {
      host.setChecks([
        { name: 'ci', state: 'neutral' },
        { name: 'lint', state: 'failure' },
      ]);
      host.setPullRequest({ mergeable: false });

      await refused('checks_failing');
      host.setChecks([{ name: 'ci', state: 'neutral' }]);
      host.setPullRequest({ mergeable: true });
      await expect(handler.execute({ runId: RUN_ID, commit: COMMIT })).resolves.toBeDefined();
    });

    it.each(['merged', 'closed'] as const)(
      'refuses a %s pull request and stores what the host showed',
      async (state) => {
        host.setPullRequest({ state });

        await refused('pull_request_not_open');

        expectNothingStoredOrCalledOnTheHost();
        expect((await stored()).retentionFacts()).toMatchObject({ pullRequestState: state });
      },
    );

    it('refuses a pull request the host does not find, and stores it as missing', async () => {
      host.refuse('readPullRequest', { code: 'not_found' });

      await refused('pull_request_not_open');

      expect(approvals.approvals).toEqual([]);
      expect((await stored()).retentionFacts()).toMatchObject({ pullRequestState: 'missing' });
    });

    it.each([
      [{ code: 'not_configured' as const }, 'merge_unavailable', undefined],
      [{ code: 'unsupported_host' as const }, 'merge_unavailable', undefined],
      [{ code: 'unavailable' as const }, 'host_refused', 'GitHub could not be reached.'],
      [
        { code: 'rate_limited' as const, retryAfterSeconds: 30 },
        'host_refused',
        'GitHub is limiting requests: try again in 30 seconds.',
      ],
      [
        { code: 'scope_mismatch' as const },
        'host_refused',
        'The pull request does not belong to this run.',
      ],
    ])('answers a failed read (%j) as %s and records nothing', async (failure, reason, detail) => {
      host.refuse('readChecks', failure);

      const error = await refused(reason);

      expect(error.detail).toBe(detail);
      expect(approvals.approvals).toEqual([]);
    });
  });

  describe('a refusal by the Git host after the approval is stored', () => {
    it.each([
      ['markReady', ['readPullRequest', 'readChecks', 'markReady']],
      ['approve', ['readPullRequest', 'readChecks', 'markReady', 'approve']],
      ['merge', ['readPullRequest', 'readChecks', 'markReady', 'approve', 'merge']],
    ] as const)(
      'keeps the approval as not carried out when %s is refused',
      async (method, calls) => {
        host.refuse(method, { code: 'refused', message: 'Required status check is expected.' });

        const error = await refused('host_refused');

        expect(error.detail).toBe('Required status check is expected.');
        expect(methods()).toEqual(calls);
        expect(approvals.approvals).toHaveLength(1);
        expect(approvals.approvals[0]).toMatchObject({
          result: 'not_carried_out',
          commit: COMMIT,
          refusal: { code: 'host_refused', reason: 'Required status check is expected.' },
          mergedCommit: null,
          completedAt: NOW,
        });
        expect((await stored()).retentionFacts().pullRequestState).not.toBe('merged');
        expect(host.runBranchDeleted).toBe(false);
        expect(fetched).toEqual([]);
      },
    );

    it('records a host that cannot be reached with its redacted words, and allows a new attempt', async () => {
      host.refuse('merge', { code: 'unavailable' });
      await refused('host_refused');
      host.refuse('merge', null);

      await expect(handler.execute({ runId: RUN_ID, commit: COMMIT })).resolves.toMatchObject({
        approval: { result: 'carried_out' },
      });

      expect(approvals.approvals.map((approval) => approval.result)).toEqual([
        'not_carried_out',
        'carried_out',
      ]);
      expect(approvals.approvals[0]!.refusal).toEqual({
        code: 'interrupted',
        reason: 'GitHub could not be reached. The merge may have gone through.',
      });
    });

    it('records a credential that was removed in between as merge_unavailable', async () => {
      host.refuse('approve', { code: 'not_configured' });

      await refused('merge_unavailable');

      expect(approvals.approvals[0]!.refusal?.code).toBe('merge_unavailable');
    });
  });

  describe('after the merge', () => {
    it('keeps the merge when the branch cannot be deleted, and a repeat retries only that', async () => {
      host.refuse('deleteRunBranch', {
        code: 'refused',
        message: 'Cannot delete a protected ref.',
      });

      const first = await handler.execute({ runId: RUN_ID, commit: COMMIT });

      expect(first.approval.result).toBe('carried_out');
      expect(first.runBranchDeletedAt).toBeNull();
      expect(first.runBranchDeletionFailure).toBe('Cannot delete a protected ref.');
      host.calls.length = 0;
      host.refuse('deleteRunBranch', null);

      const retry = await handler.execute({ runId: RUN_ID, commit: COMMIT });

      expect(methods()).toEqual(['deleteRunBranch']);
      expect(retry).toMatchObject({ runBranchDeletedAt: NOW, runBranchDeletionFailure: null });
      expect(fetched).toEqual([PROJECT]);
      expect(approvals.approvals).toHaveLength(1);
    });

    it.each(['not_started', 'throws'] as const)(
      'keeps the merge when the fetch is %s, and a repeat tries the fetch again alone',
      async (answer) => {
        fetchAnswer = answer;

        const first = await handler.execute({ runId: RUN_ID, commit: COMMIT });

        expect(first.approval.result).toBe('carried_out');
        expect(first.approval.cloneFetchStartedAt).toBeNull();
        host.calls.length = 0;
        fetchAnswer = 'started';

        const retry = await handler.execute({ runId: RUN_ID, commit: COMMIT });

        expect(host.calls).toEqual([]);
        expect(fetched).toEqual([PROJECT, PROJECT]);
        expect(retry.approval.cloneFetchStartedAt).toEqual(NOW);
        expect(approvals.approvals[0]!.cloneFetchStartedAt).toEqual(NOW);
      },
    );

    it('changes nothing when repeated once everything is done, and calls no host', async () => {
      await handler.execute({ runId: RUN_ID, commit: COMMIT });
      host.calls.length = 0;
      fetched.length = 0;
      now = new Date(NOW.getTime() + 60_000);

      const again = await handler.execute({ runId: RUN_ID, commit: 'c'.repeat(40) });

      expect(host.calls).toEqual([]);
      expect(fetched).toEqual([]);
      expect(again.approval).toMatchObject({ result: 'carried_out', commit: COMMIT });
      expect(again.approval.completedAt).toEqual(NOW);
      expect(approvals.approvals).toHaveLength(1);
    });

    it('answers the stored result for a finished merge even when merging was switched off since', async () => {
      await handler.execute({ runId: RUN_ID, commit: COMMIT });
      settings.configured = false;

      await expect(handler.execute({ runId: RUN_ID, commit: COMMIT })).resolves.toMatchObject({
        approval: { result: 'carried_out' },
      });
    });

    it('refuses to retry a missing step while merging is switched off', async () => {
      fetchAnswer = 'not_started';
      await handler.execute({ runId: RUN_ID, commit: COMMIT });
      settings.configured = false;

      await refused('merge_unavailable');
    });
  });

  describe('two requests at once', () => {
    it('merges once: the second answers merge_in_progress', async () => {
      const results = await Promise.allSettled([
        handler.execute({ runId: RUN_ID, commit: COMMIT }),
        handler.execute({ runId: RUN_ID, commit: COMMIT }),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as MergeRefusedError).reason).toBe('merge_in_progress');
      expect(methods().filter((method) => method === 'merge')).toHaveLength(1);
      expect(approvals.approvals).toHaveLength(1);
    });

    it('refuses with merge_in_progress while an approval is pending', async () => {
      await approvals.add(
        MergeApproval.approve(
          {
            id: 'e0000000-0000-4000-8000-000000000001',
            runId: RUN_ID,
            commit: COMMIT,
            integrationBranch: 'dev',
            method: 'squash',
            checksSeen: [],
          },
          new Date(NOW.getTime() - 30_000),
        ),
      );

      await refused('merge_in_progress');

      expect(host.calls).toEqual([]);
    });

    it('takes a pending approval of a request that died as interrupted, and merges', async () => {
      await approvals.add(
        MergeApproval.approve(
          {
            id: 'e0000000-0000-4000-8000-000000000001',
            runId: RUN_ID,
            commit: COMMIT,
            integrationBranch: 'dev',
            method: 'squash',
            checksSeen: [],
          },
          new Date(NOW.getTime() - 700_000),
        ),
      );

      await expect(handler.execute({ runId: RUN_ID, commit: COMMIT })).resolves.toMatchObject({
        approval: { result: 'carried_out' },
      });

      expect(approvals.approvals.map((approval) => approval.refusal?.code ?? null)).toEqual([
        'interrupted',
        null,
      ]);
    });
  });

  describe('a request that outlives its lease', () => {
    const approval = (approvedAt: Date) =>
      MergeApproval.approve(
        {
          id: 'e0000000-0000-4000-8000-000000000001',
          runId: RUN_ID,
          commit: COMMIT,
          integrationBranch: 'dev',
          method: 'squash',
          checksSeen: [],
        },
        approvedAt,
      );

    it('is taken over, and when it ends late its outcome does not overwrite the takeover', async () => {
      const release = host.hold('merge');
      const first = handler.execute({ runId: RUN_ID, commit: COMMIT });
      for (let spins = 0; !methods().includes('merge') && spins < 50; spins += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(methods()).toContain('merge');
      now = new Date(NOW.getTime() + 700_000);

      const second = await handler.execute({ runId: RUN_ID, commit: COMMIT });
      release();
      const firstResult = await first;

      expect(approvals.approvals.map((stored) => stored.refusal?.code ?? stored.result)).toEqual([
        'interrupted',
        'carried_out',
      ]);
      expect(second.approval.result).toBe('carried_out');
      expect(firstResult.approval).toMatchObject({ result: 'carried_out', id: second.approval.id });
      expect(host.runBranchDeleted).toBe(true);
    });

    it('starts no host step with too little of the lease left, and records it as interrupted', async () => {
      const release = host.hold('markReady');
      const running = refusal(handler.execute({ runId: RUN_ID, commit: COMMIT }));
      for (let spins = 0; !methods().includes('markReady') && spins < 50; spins += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      now = new Date(NOW.getTime() + 560_000);
      release();

      const error = await running;

      expect(error.reason).toBe('host_refused');
      expect(error.detail).toBe(MergeApproval.TOO_SLOW);
      expect(methods()).not.toContain('approve');
      expect(approvals.approvals[0]).toMatchObject({
        result: 'not_carried_out',
        refusal: { code: 'interrupted' },
      });
    });

    it('treats a pending approval inside its lease as live', async () => {
      await approvals.add(approval(new Date(NOW.getTime() - 500_000)));

      await refused('merge_in_progress');
    });
  });

  describe('a merge the host carried out but the record does not show', () => {
    const failedApproval = async (code: 'host_refused' | 'interrupted') => {
      const pending = MergeApproval.approve(
        {
          id: 'e0000000-0000-4000-8000-000000000002',
          runId: RUN_ID,
          commit: COMMIT,
          integrationBranch: 'dev',
          method: 'squash',
          checksSeen: [{ name: 'ci', state: 'success' }],
        },
        T0,
      ).mergeRequested(T0);
      await approvals.add(pending);
      await approvals.finish(pending.notCarriedOut(code, 'GitHub could not be reached.', T0));
    };
    const hostMergedLater = () => {
      host.refuse('markReady', null);
      host.refuse('approve', null);
      host.refuse('merge', null);
      host.setPullRequest({
        state: 'merged',
        mergedCommit: 'd'.repeat(40),
        draft: false,
        headSha: COMMIT,
      });
      host.calls.length = 0;
    };

    it('is recorded as carried out when the merge call was cut off, and the missing steps run', async () => {
      host.refuse('merge', { code: 'unavailable' });
      const first = await refusal(handler.execute({ runId: RUN_ID, commit: COMMIT }));
      expect(first.reason).toBe('host_refused');
      expect(approvals.approvals[0]).toMatchObject({ result: 'not_carried_out' });
      expect(approvals.approvals[0]!.mergeOutcomeUnknown).toBe(true);
      hostMergedLater();

      const result = await handler.execute({ runId: RUN_ID, commit: COMMIT });

      expect(result.approval).toMatchObject({
        id: approvals.approvals[0]!.id,
        result: 'carried_out',
        refusal: null,
        mergedCommit: 'd'.repeat(40),
        mergeOutcomeUnknown: false,
      });
      expect(methods()).toEqual(['readPullRequest', 'deleteRunBranch']);
      expect(fetched).toEqual([PROJECT]);
      expect(approvals.approvals).toHaveLength(1);
      expect((await stored()).retentionFacts()).toMatchObject({ pullRequestState: 'merged' });
    });

    it('also repairs an approval taken over as interrupted after its merge call started', async () => {
      await failedApproval('interrupted');
      host.setPullRequest({ state: 'merged', mergedCommit: 'd'.repeat(40) });

      await expect(handler.execute({ runId: RUN_ID, commit: COMMIT })).resolves.toMatchObject({
        approval: { result: 'carried_out' },
      });
    });

    it.each([
      ['another commit was merged', { headSha: 'c'.repeat(40) }],
      ['the host names no merge commit', { mergedCommit: null }],
      ['the pull request was only closed', { state: 'closed' as const }],
    ])('stays refused when %s', async (_name, change) => {
      await failedApproval('interrupted');
      host.setPullRequest({ state: 'merged', mergedCommit: 'd'.repeat(40), ...change });

      await refused('pull_request_not_open');

      expect(approvals.approvals[0]!.result).toBe('not_carried_out');
    });

    describe('is never recorded as merged by Studio when its merge call did not go out or was refused', () => {
      const staysNotCarriedOut = async () => {
        hostMergedLater();
        await refused('pull_request_not_open');
        expect(approvals.approvals).toHaveLength(1);
        expect(approvals.approvals[0]).toMatchObject({
          result: 'not_carried_out',
          mergedCommit: null,
        });
        expect(approvals.approvals[0]!.mergeOutcomeUnknown).toBe(false);
        expect(methods()).toEqual(['readPullRequest', 'readChecks']);
      };

      it.each(['markReady', 'approve'] as const)('after a refusal at %s', async (step) => {
        host.refuse(step, { code: 'unavailable' });
        await refused('host_refused');

        await staysNotCarriedOut();
      });

      it('after the step deadline, which stops the request before the merge call', async () => {
        const release = host.hold('markReady');
        const running = refusal(handler.execute({ runId: RUN_ID, commit: COMMIT }));
        for (let spins = 0; !methods().includes('markReady') && spins < 50; spins += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        now = new Date(NOW.getTime() + 560_000);
        release();
        await running;
        now = NOW;

        await staysNotCarriedOut();
      });

      it.each([
        { code: 'refused' as const, message: 'Required status check is expected.' },
        { code: 'rate_limited' as const, retryAfterSeconds: 30 },
        { code: 'scope_mismatch' as const },
        { code: 'not_found' as const },
      ])('after a definitive refusal of the merge itself (%j)', async (failure) => {
        host.refuse('merge', failure);
        await refused('host_refused');
        expect(approvals.approvals[0]!.mergeOutcomeUnknown).toBe(false);

        await staysNotCarriedOut();
      });
    });
  });
});
