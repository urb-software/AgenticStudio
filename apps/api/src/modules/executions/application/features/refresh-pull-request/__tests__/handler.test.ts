import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunLookupRepository } from '../../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import {
  deliveredRun,
  T0,
  WORKER,
} from '../../../../domain/repositories/__tests__/delivered-run.js';
import { RunNotFoundError } from '../../../../domain/repositories/run-repository.js';
import type { RecordedWorkerStatus } from '../../../../domain/services/provider-availability.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { PullRequestNotRefreshableError } from '../../../../domain/entities/run-lookup.js';
import { RefreshPullRequestHandler } from '../handler.js';

class Workers implements WorkerStatusStore {
  current: RecordedWorkerStatus | undefined;
  record(status: RecordedWorkerStatus): void {
    this.current = status;
  }
  latest(): RecordedWorkerStatus | undefined {
    return this.current;
  }
  lastSeen(): Date | undefined {
    return this.current?.reportedAt;
  }
}

// Issue #142: asking for the Run's pull request state to be read again.
const LEASE = { seconds: 60 };
const minutes = (count: number) => new Date(T0.getTime() + count * 60_000);

describe('RefreshPullRequestHandler', () => {
  let runs: InMemoryRunRepository;
  let lookups: InMemoryRunLookupRepository;
  let workers: Workers;
  let now: Date;
  let handler: RefreshPullRequestHandler;

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    lookups = new InMemoryRunLookupRepository(runs);
    workers = new Workers();
    now = T0;
    handler = new RefreshPullRequestHandler(runs, lookups, { now: () => now }, workers, LEASE, {
      days: 7,
      maxPerProject: 10,
      openPullRequestIdleDays: 30,
      hoursAfterPullRequestEnd: 24,
    });
  });

  const connect = (at = now) =>
    workers.record({
      workerId: WORKER,
      runner: 'fake',
      providers: { claude_code: true, codex: true },
      reportedAt: at,
    });

  /** A lookup answered at `at`: the Run's state was read then. */
  const answered = (runId: string, at: Date) => {
    const run = runs.runs.find((candidate) => candidate.id === runId)!;
    run.pullRequestStatus = { ...run.pullRequestStatus, state: 'draft', refreshedAt: at };
  };

  it('records a request and answers the Run marked as refreshing', async () => {
    connect();
    const run = await deliveredRun(runs);

    const answer = await handler.execute(run.id, { onOpen: false });

    expect(lookups.lookups).toHaveLength(1);
    expect(lookups.lookups[0]).toMatchObject({ runId: run.id, kind: 'pull_request_state' });
    expect(answer.run.pullRequestStatus.refreshRequestedAt).toEqual(T0);
    expect(answer.workerConnected).toBe(true);
  });

  it('returns the open request instead of recording a second one', async () => {
    const run = await deliveredRun(runs);

    await handler.execute(run.id, { onOpen: false });
    await handler.execute(run.id, { onOpen: false });
    await handler.execute(run.id, { onOpen: true });

    expect(lookups.lookups).toHaveLength(1);
  });

  it('asks at most once a minute per Run when the Run page asks on opening', async () => {
    const run = await deliveredRun(runs);
    answered(run.id, T0);

    now = new Date(T0.getTime() + 59_000);
    await handler.execute(run.id, { onOpen: true });
    expect(lookups.lookups).toHaveLength(0);

    now = minutes(1);
    await handler.execute(run.id, { onOpen: true });
    expect(lookups.lookups).toHaveLength(1);
  });

  it('does not ask again on opening within a minute of a lookup that failed (review S1 of #152)', async () => {
    connect();
    const run = await deliveredRun(runs);
    await handler.execute(run.id, { onOpen: true });
    const [claimed] = await lookups.claim(WORKER, now, 5, 120);
    await lookups.fail(claimed!.id, WORKER, 'GitHub could not be reached.', null, now);

    now = new Date(T0.getTime() + 59_000);
    await handler.execute(run.id, { onOpen: true });
    expect(lookups.lookups).toHaveLength(1);

    now = minutes(1);
    await handler.execute(run.id, { onOpen: true });
    expect(lookups.lookups).toHaveLength(2);
  });

  it('records one request when it is asked many times at once', async () => {
    const run = await deliveredRun(runs);

    await Promise.all(Array.from({ length: 5 }, () => handler.execute(run.id, { onOpen: false })));

    expect(lookups.lookups).toHaveLength(1);
  });

  it('asks on opening for a Run whose state was never read', async () => {
    const run = await deliveredRun(runs);

    await handler.execute(run.id, { onOpen: true });

    expect(lookups.lookups).toHaveLength(1);
  });

  it('lets the Refresh action ask at any time, even right after the state was read', async () => {
    const run = await deliveredRun(runs);
    answered(run.id, T0);

    await handler.execute(run.id, { onOpen: false });

    expect(lookups.lookups).toHaveLength(1);
  });

  it('says no agent worker is connected when none reported within the lease', async () => {
    const run = await deliveredRun(runs);
    connect(new Date(T0.getTime() - 61_000));

    const answer = await handler.execute(run.id, { onOpen: false });

    expect(answer.workerConnected).toBe(false);
  });

  it('refuses a Run without a pull request', async () => {
    const run = await deliveredRun(runs, { delivered: false });

    await expect(handler.execute(run.id, { onOpen: false })).rejects.toBeInstanceOf(
      PullRequestNotRefreshableError,
    );
    expect(lookups.lookups).toHaveLength(0);
  });

  it('answers not found for an unknown Run or an id that is not a UUID', async () => {
    await expect(
      handler.execute('9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b', { onOpen: false }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(handler.execute('nope', { onOpen: false })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });
});
