import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestState } from '../../../domain/entities/run.js';
import { deliveredRun, T0 } from '../../../domain/repositories/__tests__/delivered-run.js';
import { InMemoryRunLookupRepository } from '../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import {
  DailyPullRequestRefreshSchedule,
  RequestDailyPullRequestRefreshesHandler,
} from '../handler.js';

// Issue #142: the daily refresh asks only about Runs with an open pull request, or one of unknown
// state, that was last read more than a day ago.
const HOUR = 60 * 60 * 1000;
const SETTINGS = { intervalMs: HOUR };

describe('RequestDailyPullRequestRefreshesHandler', () => {
  let runs: InMemoryRunRepository;
  let lookups: InMemoryRunLookupRepository;
  let now: Date;
  let handler: RequestDailyPullRequestRefreshesHandler;

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    lookups = new InMemoryRunLookupRepository(runs);
    now = new Date(T0.getTime() + 48 * HOUR);
    handler = new RequestDailyPullRequestRefreshesHandler(lookups, { now: () => now });
  });

  /** A delivered Run whose pull request was read as `state` `hoursAgo` hours before `now`. */
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

    expect(await handler.execute()).toBe(3);

    expect(new Set(asked())).toEqual(new Set([draft, open, unknown]));
  });

  it('leaves out a pull request that is merged, closed or missing', async () => {
    await readRun('merged', 72);
    await readRun('closed', 72);
    await readRun('missing', 72);

    expect(await handler.execute()).toBe(0);
    expect(asked()).toEqual([]);
  });

  it('leaves out a state that was read within the day', async () => {
    await readRun('open', 23);

    expect(await handler.execute()).toBe(0);
  });

  it('leaves out a Run without a pull request, and one that is being refreshed already', async () => {
    const none = await deliveredRun(runs, { delivered: false });
    expect(none.pullRequest).toBeNull();
    const busy = await readRun('open', 30);
    await lookups.request(busy, 'pull_request_state', now);
    const before = lookups.lookups.length;

    expect(await handler.execute()).toBe(0);
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

    expect(await handler.execute()).toBe(0);

    stored.pullRequestStatus = {
      ...stored.pullRequestStatus,
      lastAttemptAt: new Date(now.getTime() - 25 * HOUR),
    };
    expect(await handler.execute()).toBe(1);
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

    expect(await handler.execute()).toBe(1);
    expect(await handler.execute()).toBe(0);
    expect(lookups.lookups).toHaveLength(1);
  });

  it('records requests only: nothing in a lookup starts an agent', async () => {
    await readRun('open', 30);
    await handler.execute();

    expect(lookups.lookups.every((lookup) => lookup.kind === 'pull_request_state')).toBe(true);
    expect(lookups.lookups.every((lookup) => lookup.status === 'requested')).toBe(true);
  });
});

describe('DailyPullRequestRefreshSchedule', () => {
  afterEach(() => vi.useRealTimers());

  it('does nothing while the app starts: the first pass comes a minute later, then every interval', async () => {
    vi.useFakeTimers();
    let passes = 0;
    const counting = {
      execute: async () => {
        passes++;
        return 0;
      },
    } as unknown as RequestDailyPullRequestRefreshesHandler;
    const schedule = new DailyPullRequestRefreshSchedule(counting, { intervalMs: HOUR });

    schedule.onApplicationBootstrap();
    expect(passes).toBe(0);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(passes).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(passes).toBe(2);
    schedule.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(passes).toBe(2);
  });

  it('hands its pass to a test instead of starting a timer', async () => {
    let passes = 0;
    let handed: (() => Promise<void>) | undefined;
    const counting = {
      execute: async () => {
        passes++;
        return 0;
      },
    } as unknown as RequestDailyPullRequestRefreshesHandler;
    const schedule = new DailyPullRequestRefreshSchedule(counting, {
      intervalMs: HOUR,
      manual: (pass) => (handed = pass),
    });

    schedule.onApplicationBootstrap();

    expect(passes).toBe(0);
    await handed?.();
    expect(passes).toBe(1);
  });

  it('never throws when a pass fails', async () => {
    const failing = {
      execute: () => Promise.reject(new Error('The database is down')),
    } as unknown as RequestDailyPullRequestRefreshesHandler;

    await expect(
      new DailyPullRequestRefreshSchedule(failing, SETTINGS).tick(),
    ).resolves.toBeUndefined();
  });

  it('runs one pass at a time', async () => {
    let passes = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      execute: async () => {
        passes++;
        await held;
        return 0;
      },
    } as unknown as RequestDailyPullRequestRefreshesHandler;
    const schedule = new DailyPullRequestRefreshSchedule(slow, SETTINGS);

    const first = schedule.tick();
    await schedule.tick();
    release();
    await first;

    expect(passes).toBe(1);
  });
});
