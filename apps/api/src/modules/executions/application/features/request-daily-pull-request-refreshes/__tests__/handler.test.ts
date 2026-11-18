import { beforeEach, describe, expect, it } from 'vitest';
import type { PullRequestState } from '../../../../domain/value-objects/run-pull-request-status.js';
import { deliveredRun, T0 } from '../../../../domain/repositories/__tests__/delivered-run.js';
import type { InMemoryRunLookupRepository } from '../../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { inMemoryExecutions } from '../../../__tests__/in-memory-executions.js';
import type { RunLookupRequests } from '../../../run-lookup-requests.js';
import { RequestDailyPullRequestRefreshesHandler } from '../handler.js';

const HOUR = 60 * 60 * 1000;

describe('RequestDailyPullRequestRefreshesHandler', () => {
  let runs: InMemoryRunRepository;
  let lookups: InMemoryRunLookupRepository;
  let requests: RunLookupRequests;
  let now: Date;
  let handler: RequestDailyPullRequestRefreshesHandler;

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    ({ lookups, requests } = inMemoryExecutions(runs));
    now = new Date(T0.getTime() + 48 * HOUR);
    handler = new RequestDailyPullRequestRefreshesHandler(lookups, runs, requests, {
      now: () => now,
    });
  });

  async function readRun(state: PullRequestState | null, hoursAgo: number | null) {
    const run = await deliveredRun(runs);
    const stored = runs.runs.find((candidate) => candidate.id === run.id)!;
    stored.pullRequestStatus = {
      ...stored.pullRequestStatus,
      state,
      refreshedAt: hoursAgo === null ? null : new Date(now.getTime() - hoursAgo * HOUR),
    };
    return run.id;
  }
  const asked = () => lookups.lookups.map((lookup) => lookup.runId);

  it('asks about Runs whose pull request is open, draft or unknown and was read over a day ago', async () => {
    const draft = await readRun('draft', 25);
    const open = await readRun('open', 30);
    const unknown = await readRun(null, null);

    expect(await handler.execute()).toEqual({ requested: 3 });

    expect(new Set(asked())).toEqual(new Set([draft, open, unknown]));
  });

  it('leaves out a pull request that is merged, closed or missing', async () => {
    await readRun('merged', 72);
    await readRun('closed', 72);
    await readRun('missing', 72);

    expect(await handler.execute()).toEqual({ requested: 0 });
    expect(asked()).toEqual([]);
  });

  it('leaves out a state that was read within the day', async () => {
    await readRun('open', 23);

    expect(await handler.execute()).toEqual({ requested: 0 });
  });

  it('leaves out a Run without a pull request, and one that is being refreshed already', async () => {
    const none = await deliveredRun(runs, { delivered: false });
    expect(none.delivery.pullRequest).toBeNull();
    const busy = await readRun('open', 30);
    await requests.request(busy, 'pull_request_state', now);
    const before = lookups.lookups.length;

    expect(await handler.execute()).toEqual({ requested: 0 });
    expect(lookups.lookups).toHaveLength(before);
  });

  it('asks a Run whose lookups keep failing once a day, not at every pass (review S2 of #152)', async () => {
    const failing = await readRun(null, null);
    const stored = runs.runs.find((candidate) => candidate.id === failing)!;
    stored.pullRequestStatus = {
      ...stored.pullRequestStatus,
      refreshError: 'GitHub could not be reached.',
      lastAttemptAt: new Date(now.getTime() - 2 * HOUR),
    };

    expect(await handler.execute()).toEqual({ requested: 0 });

    stored.pullRequestStatus = {
      ...stored.pullRequestStatus,
      lastAttemptAt: new Date(now.getTime() - 25 * HOUR),
    };
    expect(await handler.execute()).toEqual({ requested: 1 });
  });

  it('removes finished lookups older than a week and keeps the rest (review S10 of #152)', async () => {
    const run = await readRun('open', 1);
    const at = (days: number) => new Date(now.getTime() - days * 24 * HOUR);
    const entry = {
      runId: run,
      kind: 'pull_request_state' as const,
      requestedAt: at(9),
      claimedBy: null,
      claimedAt: null,
      retryAt: null,
      error: null,
      scope: null,
      since: null,
    };
    lookups.lookups.push(
      { ...entry, id: 'old-done', status: 'done', finishedAt: at(8) },
      { ...entry, id: 'old-failed', status: 'failed', finishedAt: at(7.5) },
      { ...entry, id: 'recent-done', status: 'done', finishedAt: at(6) },
      { ...entry, id: 'open', status: 'requested', finishedAt: null },
    );

    await handler.execute();

    expect(lookups.lookups.map((lookup) => lookup.id)).toEqual(['recent-done', 'open']);
  });

  it('asks once for a Run, however often it runs', async () => {
    await readRun('open', 30);

    expect(await handler.execute()).toEqual({ requested: 1 });
    expect(await handler.execute()).toEqual({ requested: 0 });
    expect(lookups.lookups).toHaveLength(1);
  });

  it('records requests only: nothing in a lookup starts an agent', async () => {
    await readRun('open', 30);
    await handler.execute();

    expect(lookups.lookups.every((lookup) => lookup.kind === 'pull_request_state')).toBe(true);
    expect(lookups.lookups.every((lookup) => lookup.status === 'requested')).toBe(true);
  });
});
