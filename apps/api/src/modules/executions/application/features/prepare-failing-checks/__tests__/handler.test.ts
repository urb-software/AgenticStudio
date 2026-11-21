import { beforeEach, describe, expect, it } from 'vitest';
import {
  deliveredRun,
  T0,
  WORKER,
} from '../../../../domain/repositories/__tests__/delivered-run.js';
import { PreparedFollowUp } from '../../../../domain/entities/prepared-follow-up.js';
import type { InMemoryRunLookupRepository } from '../../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { inMemoryExecutions } from '../../../__tests__/in-memory-executions.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import type { WorkerStatusData } from '../../../../domain/value-objects/worker-status-data.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { DiscardPreparedFollowUpHandler } from '../../discard-prepared-follow-up/handler.js';
import {
  GetPreparedFollowUpHandler,
  PreparedFollowUpNotFoundError,
} from '../../get-prepared-follow-up/handler.js';
import { RetentionPolicy } from '../../../../domain/value-objects/retention-policy.js';
import { GetRunHandler } from '../../get-run/handler.js';
import { NoFailingChecksError, PrepareFailingChecksHandler } from '../handler.js';
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

describe('preparing a Follow-up from failing checks', () => {
  let runs: InMemoryRunRepository;
  let lookups: InMemoryRunLookupRepository;
  let executions: ReturnType<typeof inMemoryExecutions>;
  let workers: Workers;
  let prepare: PrepareFailingChecksHandler;
  let getRun: GetRunHandler;

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    executions = inMemoryExecutions(runs);
    lookups = executions.lookups;
    workers = new Workers();
    const clock = { now: () => T0 };
    prepare = new PrepareFailingChecksHandler(runs, executions.requests, clock);
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
      { configured: false, allowFileRemotes: false },
    );
  });

  const connect = () =>
    workers.record({
      workerId: WORKER,
      runner: 'fake',
      providers: { claude_code: true, codex: true },
      reportedAt: T0,
    });

  async function runWithChecks(...states: ('passed' | 'failed' | 'running')[]) {
    const run = await deliveredRun(runs);
    const stored = runs.runs.find((candidate) => candidate.id === run.id)!;
    stored.pullRequestStatus = {
      ...stored.pullRequestStatus,
      state: 'open',
      checks: {
        commit: 'c'.repeat(40),
        checks: states.map((state, index) => ({
          name: `check ${index}`,
          state,
          url: 'https://ci.test/1',
        })),
      },
    };
    return run;
  }

  it('records a request for the logs and answers the Run marked as preparing', async () => {
    connect();
    const run = await runWithChecks('passed', 'failed');

    await prepare.execute({ runId: run.id });
    const answer = await getRun.execute({ runId: run.id });

    expect(lookups.lookups).toHaveLength(1);
    expect(lookups.lookups[0]).toMatchObject({ runId: run.id, kind: 'failing_check_logs' });
    expect(answer.run.pullRequestStatus.preparation).toBe('preparing');
    expect((await runs.findById(run.id))!.pullRequestStatus.prepareRequestedAt).toEqual(T0);
    expect(answer.run.pullRequestStatus.refresh).toBe('idle');
    expect((await runs.findById(run.id))!.progress.followUpQueued).toBe(false);
    expect(answer.run.messages.some((message) => message.kind === 'follow_up')).toBe(false);
  });

  it('is the open preparation when asked twice', async () => {
    const run = await runWithChecks('failed');

    await prepare.execute({ runId: run.id });
    await prepare.execute({ runId: run.id });

    expect(lookups.lookups).toHaveLength(1);
  });

  it('refuses a Run none of whose checks is known to have failed', async () => {
    const passing = await runWithChecks('passed', 'running');
    await expect(prepare.execute({ runId: passing.id })).rejects.toBeInstanceOf(
      NoFailingChecksError,
    );

    const unread = await deliveredRun(runs);
    await expect(prepare.execute({ runId: unread.id })).rejects.toBeInstanceOf(
      NoFailingChecksError,
    );
    expect(lookups.lookups).toHaveLength(0);
  });

  it('refuses a Run without a pull request, and an unknown one', async () => {
    const none = await deliveredRun(runs, { delivered: false });
    await expect(prepare.execute({ runId: none.id })).rejects.toBeInstanceOf(
      PullRequestNotRefreshableError,
    );
    await expect(prepare.execute({ runId: 'not-a-run' })).rejects.toBeInstanceOf(RunNotFoundError);
  });

  describe('reviewing the prepared Follow-up', () => {
    const draftData = {
      source: 'pull_request_checks' as const,
      text: 'Fix it.',
      items: [{ name: 'unit tests', url: 'https://ci.test/1', logAvailable: true, section: 'x' }],
    };
    const draft = PreparedFollowUp.restore(draftData);

    it('reads the prepared Follow-up, and says when there is none', async () => {
      const get = new GetPreparedFollowUpHandler(executions.preparedFollowUps);
      const run = await runWithChecks('failed');
      await expect(get.execute({ runId: run.id })).rejects.toBeInstanceOf(
        PreparedFollowUpNotFoundError,
      );

      runs.prepared.set(run.id, draft);

      expect(await get.execute({ runId: run.id })).toEqual(draftData);
      await expect(get.execute({ runId: 'not-a-run' })).rejects.toBeInstanceOf(RunNotFoundError);
    });

    it('discards it without sending anything, and a missing one is fine', async () => {
      const discard = new DiscardPreparedFollowUpHandler(executions.preparedFollowUps);
      const run = await runWithChecks('failed');
      runs.prepared.set(run.id, draft);
      const stored = runs.runs.find((candidate) => candidate.id === run.id)!;

      await discard.execute({ runId: run.id });
      await discard.execute({ runId: run.id });

      expect(runs.prepared.has(run.id)).toBe(false);
      expect(stored.followUpQueued).toBe(false);
      await expect(discard.execute({ runId: 'not-a-run' })).rejects.toBeInstanceOf(
        RunNotFoundError,
      );
    });
  });
});
