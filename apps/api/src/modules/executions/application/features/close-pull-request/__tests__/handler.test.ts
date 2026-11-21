import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMergeHost } from '../../../ports/__tests__/in-memory-merge-host.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { deliveredRun, PROJECT } from '../../../../domain/repositories/__tests__/delivered-run.js';
import {
  CloseInProgressError,
  ClosePullRequestRefusedError,
  RunNotFoundError,
} from '../../../../domain/errors/run-errors.js';
import type { RunIntegrationFetches } from '../../../../../projects/contracts/index.js';
import type { MergeSettings } from '../../../ports/merge-settings.js';
import { ClosePullRequestHandler } from '../handler.js';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const LIMITS = { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 };

describe('ClosePullRequestHandler', () => {
  let runs: InMemoryRunRepository;
  let host: InMemoryMergeHost;
  let settings: MergeSettings;
  let now: Date;
  let handler: ClosePullRequestHandler;
  let fetched: string[];
  let failFetch: boolean;

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    host = new InMemoryMergeHost();
    settings = { configured: true, allowFileRemotes: false };
    now = NOW;
    fetched = [];
    failFetch = false;
    handler = new ClosePullRequestHandler(runs, host, settings, { now: () => now }, fetches);
  });

  const fetches: RunIntegrationFetches = {
    fetchIntegrationBranch: (projectId) => {
      fetched.push(projectId);
      return failFetch
        ? Promise.reject(new Error('queue down'))
        : Promise.resolve({ status: 'started' });
    },
  };

  const methods = () => host.calls.map((call) => call.method);
  const stored = async () => (await runs.findById(RUN_ID))!;
  const queuedRun = (remoteUrl = 'https://github.com/acme/shop.git') =>
    runs.start({
      id: RUN_ID,
      projectId: PROJECT,
      provider: 'claude_code',
      task: 'x',
      startCommit: 'a',
      remoteUrl,
      limits: LIMITS,
      integrationBranch: 'dev',
    });
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ClosePullRequestRefusedError);
    return error as ClosePullRequestRefusedError;
  };

  it('closes the pull request with the Run own scope, then deletes the Run branch', async () => {
    await deliveredRun(runs, { id: RUN_ID });

    const result = await handler.execute({ runId: RUN_ID });

    expect(methods()).toEqual(['readPullRequest', 'close', 'deleteRunBranch']);
    expect(host.calls[1]!.scope).toEqual({
      remoteUrl: 'https://github.com/acme/shop.git',
      runId: RUN_ID,
      integrationBranch: 'dev',
      runBranch: 'agent/x-r0b8e5c2d',
      pullRequestNumber: 7,
    });
    expect(host.runBranchDeleted).toBe(true);
    expect(result).toEqual({
      state: 'closed',
      closedFromStudioAt: NOW,
      runBranchDeletedAt: NOW,
      runBranchDeletionFailure: null,
    });
    expect((await stored()).retentionFacts()).toMatchObject({
      pullRequestState: 'closed',
      pullRequestEndedAt: NOW,
    });
    expect((await stored()).pullRequestStatus.closeClaimedAt).toBeNull();
  });

  it('fetches the Integration branch of the Run project after the close and the deletion', async () => {
    await deliveredRun(runs, { id: RUN_ID });

    await handler.execute({ runId: RUN_ID });

    expect(fetched).toEqual([PROJECT]);
  });

  it('keeps the close when the fetch cannot be started, and fetches again only on a retry of the deletion', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    failFetch = true;

    await expect(handler.execute({ runId: RUN_ID })).resolves.toMatchObject({ state: 'closed' });
    await handler.execute({ runId: RUN_ID });

    expect(fetched).toEqual([PROJECT]);
    expect((await stored()).pullRequestStatus.closedFromStudioAt).toEqual(NOW);
  });

  it('does not fetch when nothing was closed', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    host.refuse('close', { code: 'unavailable' });

    await refusal(handler.execute({ runId: RUN_ID }));

    expect(fetched).toEqual([]);
  });

  it('records a pull request the host closed for an earlier attempt of ours that died, and deletes the branch', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    await runs.change(RUN_ID, (run) => void run.claimClose(NOW));
    host.setPullRequest({ state: 'closed' });
    now = new Date(NOW.getTime() + 300_000);

    const result = await handler.execute({ runId: RUN_ID });

    expect(methods()).toEqual(['readPullRequest', 'deleteRunBranch']);
    expect(result).toMatchObject({ state: 'closed', closedFromStudioAt: now });
  });

  it('keeps the Run closed when a late lookup reads the pull request as open, and ends that refresh', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    await handler.execute({ runId: RUN_ID });

    await runs.change(RUN_ID, (run) => {
      run.recordLookupRequested('pull_request_state', now);
      run.recordPullRequestState({ state: 'open', behindBy: 0, aheadBy: 1 }, now);
    });

    expect((await stored()).pullRequestStatus).toMatchObject({
      state: 'closed',
      closedFromStudioAt: NOW,
      refreshRequestedAt: null,
    });
  });

  it('refuses an unknown or malformed Run', async () => {
    await expect(handler.execute({ runId: 'nope' })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(handler.execute({ runId: RUN_ID })).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it('refuses merge_unavailable while the credential is not set, without a host call', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    handler = new ClosePullRequestHandler(
      runs,
      host,
      { configured: false, allowFileRemotes: false },
      { now: () => now },
      fetches,
    );

    expect((await refusal(handler.execute({ runId: RUN_ID }))).reason).toBe('merge_unavailable');
    expect(host.calls).toEqual([]);
  });

  it('refuses merge_unavailable for a remote that is not on GitHub', async () => {
    await queuedRun('https://git.example.test/acme/shop.git');

    expect((await refusal(handler.execute({ runId: RUN_ID }))).reason).toBe('merge_unavailable');
    expect(host.calls).toEqual([]);
  });

  it('refuses run_active while the Run has not ended', async () => {
    await queuedRun();

    expect((await refusal(handler.execute({ runId: RUN_ID }))).reason).toBe('run_active');
    expect(host.calls).toEqual([]);
  });

  it('refuses pull_request_not_open for a Run without a pull request', async () => {
    await deliveredRun(runs, { id: RUN_ID, delivered: false });

    expect((await refusal(handler.execute({ runId: RUN_ID }))).reason).toBe(
      'pull_request_not_open',
    );
    expect(host.calls).toEqual([]);
  });

  it.each(['merged', 'closed'] as const)(
    'stores a pull request the host reads as %s, and refuses pull_request_not_open',
    async (state) => {
      await deliveredRun(runs, { id: RUN_ID });
      host.setPullRequest({ state });

      expect((await refusal(handler.execute({ runId: RUN_ID }))).reason).toBe(
        'pull_request_not_open',
      );

      expect(methods()).toEqual(['readPullRequest']);
      expect((await stored()).pullRequestStatus).toMatchObject({
        state,
        refreshedAt: NOW,
        endedAt: NOW,
        closeClaimedAt: null,
        closedFromStudioAt: null,
      });
    },
  );

  it('stores a pull request the host does not know as missing', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    host.refuse('readPullRequest', { code: 'not_found' });

    expect((await refusal(handler.execute({ runId: RUN_ID }))).reason).toBe(
      'pull_request_not_open',
    );
    expect((await stored()).pullRequestStatus.state).toBe('missing');
  });

  it.each([
    [{ code: 'refused', message: 'Resource not accessible.' } as const, 'Resource not accessible.'],
    [{ code: 'rate_limited', retryAfterSeconds: 30 } as const, '30 seconds'],
    [{ code: 'unavailable' } as const, 'could not be reached'],
    [{ code: 'scope_mismatch' } as const, 'does not belong'],
  ])('answers host_refused for %j on the close and records nothing', async (failure, reason) => {
    await deliveredRun(runs, { id: RUN_ID });
    host.refuse('close', failure);

    const error = await refusal(handler.execute({ runId: RUN_ID }));

    expect(error.reason).toBe('host_refused');
    expect(error.detail).toContain(reason);
    expect(methods()).toEqual(['readPullRequest', 'close']);
    expect((await stored()).pullRequestStatus).toMatchObject({
      state: null,
      closedFromStudioAt: null,
      closeClaimedAt: null,
    });
    host.refuse('close', null);
    await expect(handler.execute({ runId: RUN_ID })).resolves.toMatchObject({ state: 'closed' });
  });

  it('answers host_refused when the pull request cannot be read', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    host.refuse('readPullRequest', { code: 'unavailable' });

    expect((await refusal(handler.execute({ runId: RUN_ID }))).reason).toBe('host_refused');
    expect(methods()).toEqual(['readPullRequest']);
    expect((await stored()).pullRequestStatus.closeClaimedAt).toBeNull();
  });

  it('keeps the close when the branch deletion fails, and retries only the deletion', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    host.refuse('deleteRunBranch', { code: 'refused', message: 'Branch is protected.' });

    const first = await handler.execute({ runId: RUN_ID });

    expect(first).toEqual({
      state: 'closed',
      closedFromStudioAt: NOW,
      runBranchDeletedAt: null,
      runBranchDeletionFailure: 'Branch is protected.',
    });
    expect((await stored()).pullRequestStatus.closeClaimedAt).toBeNull();

    host.calls.length = 0;
    host.refuse('deleteRunBranch', null);
    now = new Date(NOW.getTime() + 60_000);
    const retried = await handler.execute({ runId: RUN_ID });

    expect(methods()).toEqual(['deleteRunBranch']);
    expect(retried).toEqual({
      state: 'closed',
      closedFromStudioAt: NOW,
      runBranchDeletedAt: now,
      runBranchDeletionFailure: null,
    });
  });

  it('counts a branch the host no longer has as deleted', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    host.refuse('deleteRunBranch', { code: 'not_found' });

    expect((await handler.execute({ runId: RUN_ID })).runBranchDeletedAt).toEqual(NOW);
  });

  it('changes nothing and calls no host when the close and the deletion are both done', async () => {
    await deliveredRun(runs, { id: RUN_ID });
    const first = await handler.execute({ runId: RUN_ID });
    host.calls.length = 0;
    now = new Date(NOW.getTime() + 3_600_000);

    const again = await handler.execute({ runId: RUN_ID });

    expect(again).toEqual(first);
    expect(host.calls).toEqual([]);
  });

  it('lets one of two simultaneous requests close, and tells the other to wait', async () => {
    await deliveredRun(runs, { id: RUN_ID });

    const results = await Promise.allSettled([
      handler.execute({ runId: RUN_ID }),
      handler.execute({ runId: RUN_ID }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(CloseInProgressError);
    expect(host.calls.filter((call) => call.method === 'close')).toHaveLength(1);
  });
});
