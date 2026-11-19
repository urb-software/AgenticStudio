import { beforeEach, describe, expect, it } from 'vitest';
import type { InMemoryRunLookupRepository } from '../../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { inMemoryExecutions } from '../../../__tests__/in-memory-executions.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import {
  deliveredRun,
  T0,
  WORKER,
} from '../../../../domain/repositories/__tests__/delivered-run.js';
import type { WorkerStatusData } from '../../../../domain/value-objects/worker-status-data.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { RetentionPolicy } from '../../../../domain/value-objects/retention-policy.js';
import { LookupHandOutRule } from '../../../../domain/value-objects/lookup-hand-out-rule.js';
import { ReportLookupResultHandler } from '../../report-lookup-result/handler.js';
import { GetRunHandler } from '../../get-run/handler.js';
import { RefreshPullRequestHandler } from '../handler.js';
import {
  RunNotFoundError,
  PullRequestNotRefreshableError,
} from '../../../../domain/errors/run-errors.js';

class Workers implements WorkerStatusStore {
  current: WorkerStatusData | undefined;
  record(status: WorkerStatusData): void {
    this.current = status;
  }
  latest(): WorkerStatusData | undefined {
    return this.current;
  }
  lastSeen(): Date | undefined {
    return this.current?.reportedAt;
  }
}

const LEASE = { seconds: 60 };
const minutes = (count: number) => new Date(T0.getTime() + count * 60_000);

describe('RefreshPullRequestHandler', () => {
  let runs: InMemoryRunRepository;
  let lookups: InMemoryRunLookupRepository;
  let executions: ReturnType<typeof inMemoryExecutions>;
  let workers: Workers;
  let now: Date;
  let handler: RefreshPullRequestHandler;
  let getRun: GetRunHandler;

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    executions = inMemoryExecutions(runs);
    lookups = executions.lookups;
    workers = new Workers();
    now = T0;
    const clock = { now: () => now };
    handler = new RefreshPullRequestHandler(runs, executions.requests, clock);
    getRun = new GetRunHandler(
      runs,
      clock,
      workers,
      executions.preparedFollowUps,
      LEASE,
      RetentionPolicy.of({
        days: 7,
        maxPerProject: 10,
        openPullRequestIdleDays: 30,
        hoursAfterPullRequestEnd: 24,
      }),
    );
  });

  const connect = (at = now) =>
    workers.record({
      workerId: WORKER,
      runner: 'fake',
      providers: { claude_code: true, codex: true },
      reportedAt: at,
    });

  const answered = (runId: string, at: Date) => {
    const run = runs.runs.find((candidate) => candidate.id === runId)!;
    run.pullRequestStatus = { ...run.pullRequestStatus, state: 'draft', refreshedAt: at };
  };

  it('records a request and answers the Run marked as refreshing', async () => {
    connect();
    const run = await deliveredRun(runs);

    await handler.execute({ runId: run.id, onOpen: false });
    const answer = await getRun.execute({ runId: run.id });

    expect(lookups.lookups).toHaveLength(1);
    expect(lookups.lookups[0]).toMatchObject({ runId: run.id, kind: 'pull_request_state' });
    expect(answer.run.pullRequestStatus.refresh).toBe('refreshing');
    expect((await runs.findById(run.id))!.pullRequestStatus.refreshRequestedAt).toEqual(T0);
  });

  it('returns the open request instead of recording a second one', async () => {
    const run = await deliveredRun(runs);

    await handler.execute({ runId: run.id, onOpen: false });
    await handler.execute({ runId: run.id, onOpen: false });
    await handler.execute({ runId: run.id, onOpen: true });

    expect(lookups.lookups).toHaveLength(1);
  });

  it('asks at most once a minute per Run when the Run page asks on opening', async () => {
    const run = await deliveredRun(runs);
    answered(run.id, T0);

    now = new Date(T0.getTime() + 59_000);
    await handler.execute({ runId: run.id, onOpen: true });
    expect(lookups.lookups).toHaveLength(0);

    now = minutes(1);
    await handler.execute({ runId: run.id, onOpen: true });
    expect(lookups.lookups).toHaveLength(1);
  });

  it('does not ask again on opening within a minute of a lookup that failed', async () => {
    connect();
    const run = await deliveredRun(runs);
    await handler.execute({ runId: run.id, onOpen: true });
    const [claimed] = await lookups.claim(
      WORKER,
      LookupHandOutRule.at(now, { limit: 5, leaseSeconds: 120 }),
    );
    await new ReportLookupResultHandler(
      lookups,
      { now: () => now },
      runs,
      { forRun: () => Promise.resolve([]) },
      executions.transactions,
    ).execute({
      lookupId: claimed!.id,
      answer: {
        ok: false,
        workerId: WORKER,
        code: 'failed',
        error: 'GitHub could not be reached.',
      },
    });

    now = new Date(T0.getTime() + 59_000);
    await handler.execute({ runId: run.id, onOpen: true });
    expect(lookups.lookups).toHaveLength(1);

    now = minutes(1);
    await handler.execute({ runId: run.id, onOpen: true });
    expect(lookups.lookups).toHaveLength(2);
  });

  it('records one request when it is asked many times at once', async () => {
    const run = await deliveredRun(runs);

    await Promise.all(
      Array.from({ length: 5 }, () => handler.execute({ runId: run.id, onOpen: false })),
    );

    expect(lookups.lookups).toHaveLength(1);
  });

  it('asks on opening for a Run whose state was never read', async () => {
    const run = await deliveredRun(runs);

    await handler.execute({ runId: run.id, onOpen: true });

    expect(lookups.lookups).toHaveLength(1);
  });

  it('lets the Refresh action ask at any time, even right after the state was read', async () => {
    const run = await deliveredRun(runs);
    answered(run.id, T0);

    await handler.execute({ runId: run.id, onOpen: false });

    expect(lookups.lookups).toHaveLength(1);
  });

  it('says no agent worker is connected when none reported within the lease', async () => {
    const run = await deliveredRun(runs);
    connect(new Date(T0.getTime() - 61_000));

    await handler.execute({ runId: run.id, onOpen: false });
    const answer = await getRun.execute({ runId: run.id });

    expect(answer.run.pullRequestStatus.refresh).toBe('no_worker');
  });

  it('refuses a Run without a pull request', async () => {
    const run = await deliveredRun(runs, { delivered: false });

    await expect(handler.execute({ runId: run.id, onOpen: false })).rejects.toBeInstanceOf(
      PullRequestNotRefreshableError,
    );
    expect(lookups.lookups).toHaveLength(0);
  });

  it('answers not found for an unknown Run or an id that is not a UUID', async () => {
    await expect(
      handler.execute({ runId: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b', onOpen: false }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(handler.execute({ runId: 'nope', onOpen: false })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });
});
