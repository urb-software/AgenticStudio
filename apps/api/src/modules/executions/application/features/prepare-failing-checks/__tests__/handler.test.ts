import { beforeEach, describe, expect, it } from 'vitest';
import {
  deliveredRun,
  T0,
  WORKER,
} from '../../../../domain/repositories/__tests__/delivered-run.js';
import { InMemoryRunLookupRepository } from '../../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunNotFoundError } from '../../../../domain/repositories/run-repository.js';
import type { RecordedWorkerStatus } from '../../../../domain/services/provider-availability.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { DiscardPreparedFollowUpHandler } from '../../discard-prepared-follow-up/handler.js';
import {
  GetPreparedFollowUpHandler,
  PreparedFollowUpNotFoundError,
} from '../../get-prepared-follow-up/handler.js';
import { PullRequestNotRefreshableError } from '../../refresh-pull-request/handler.js';
import { NoFailingChecksError, PrepareFailingChecksHandler } from '../handler.js';

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

// Issue #145: asking for the failing Pull request checks to be turned into a Follow-up.
const LEASE = { seconds: 60 };

describe('preparing a Follow-up from failing checks', () => {
  let runs: InMemoryRunRepository;
  let lookups: InMemoryRunLookupRepository;
  let workers: Workers;
  let prepare: PrepareFailingChecksHandler;

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    lookups = new InMemoryRunLookupRepository(runs);
    workers = new Workers();
    prepare = new PrepareFailingChecksHandler(runs, lookups, { now: () => T0 }, workers, LEASE, {
      days: 7,
      maxPerProject: 10,
      openPullRequestIdleDays: 30,
      hoursAfterPullRequestEnd: 24,
    });
  });

  const connect = () =>
    workers.record({
      workerId: WORKER,
      runner: 'fake',
      providers: { claude_code: true, codex: true },
      reportedAt: T0,
    });

  /** A delivered Run whose stored checks are `states`. */
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

    const answer = await prepare.execute(run.id);

    expect(lookups.lookups).toHaveLength(1);
    expect(lookups.lookups[0]).toMatchObject({ runId: run.id, kind: 'failing_check_logs' });
    expect(answer.run.pullRequestStatus.prepareRequestedAt).toEqual(T0);
    // It is not a refresh of the state, and nothing is sent to an agent.
    expect(answer.run.pullRequestStatus.refreshRequestedAt).toBeNull();
    expect(answer.run.followUpQueued).toBe(false);
    expect(answer.run.messages.some((message) => message.kind === 'follow_up')).toBe(false);
  });

  it('is the open preparation when asked twice', async () => {
    const run = await runWithChecks('failed');

    await prepare.execute(run.id);
    await prepare.execute(run.id);

    expect(lookups.lookups).toHaveLength(1);
  });

  it('refuses a Run none of whose checks is known to have failed', async () => {
    const passing = await runWithChecks('passed', 'running');
    await expect(prepare.execute(passing.id)).rejects.toBeInstanceOf(NoFailingChecksError);

    const unread = await deliveredRun(runs);
    await expect(prepare.execute(unread.id)).rejects.toBeInstanceOf(NoFailingChecksError);
    expect(lookups.lookups).toHaveLength(0);
  });

  it('refuses a Run without a pull request, and an unknown one', async () => {
    const none = await deliveredRun(runs, { delivered: false });
    await expect(prepare.execute(none.id)).rejects.toBeInstanceOf(PullRequestNotRefreshableError);
    await expect(prepare.execute('not-a-run')).rejects.toBeInstanceOf(RunNotFoundError);
  });

  describe('reviewing the prepared Follow-up', () => {
    const draft = {
      source: 'pull_request_checks' as const,
      text: 'Fix it.',
      items: [{ name: 'unit tests', url: 'https://ci.test/1', logAvailable: true, section: 'x' }],
    };

    it('reads the prepared Follow-up, and says when there is none', async () => {
      const get = new GetPreparedFollowUpHandler(lookups);
      const run = await runWithChecks('failed');
      await expect(get.execute(run.id)).rejects.toBeInstanceOf(PreparedFollowUpNotFoundError);

      runs.prepared.set(run.id, draft);

      expect(await get.execute(run.id)).toEqual(draft);
      await expect(get.execute('not-a-run')).rejects.toBeInstanceOf(RunNotFoundError);
    });

    it('discards it without sending anything, and a missing one is fine', async () => {
      const discard = new DiscardPreparedFollowUpHandler(lookups);
      const run = await runWithChecks('failed');
      runs.prepared.set(run.id, draft);
      const stored = runs.runs.find((candidate) => candidate.id === run.id)!;

      await discard.execute(run.id);
      await discard.execute(run.id);

      expect(runs.prepared.has(run.id)).toBe(false);
      expect(stored.followUpQueued).toBe(false);
      await expect(discard.execute('not-a-run')).rejects.toBeInstanceOf(RunNotFoundError);
    });
  });
});
