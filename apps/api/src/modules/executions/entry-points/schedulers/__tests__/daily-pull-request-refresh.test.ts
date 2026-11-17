import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestDailyPullRequestRefreshesHandler } from '../../../application/features/request-daily-pull-request-refreshes/handler.js';
import { DailyPullRequestRefreshScheduler } from '../daily-pull-request-refresh.js';

// Issue #142: the daily refresh waits a minute after start, then asks every interval.
const HOUR = 60 * 60 * 1000;
const SETTINGS = { intervalMs: HOUR };

describe('DailyPullRequestRefreshScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('does nothing while the app starts: the first pass comes a minute later, then every interval', async () => {
    vi.useFakeTimers();
    let passes = 0;
    const counting = {
      execute: async () => {
        passes++;
        return { requested: 0 };
      },
    } as unknown as RequestDailyPullRequestRefreshesHandler;
    const schedule = new DailyPullRequestRefreshScheduler(counting, { intervalMs: HOUR });

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
        return { requested: 0 };
      },
    } as unknown as RequestDailyPullRequestRefreshesHandler;
    const schedule = new DailyPullRequestRefreshScheduler(counting, {
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
      new DailyPullRequestRefreshScheduler(failing, SETTINGS).tick(),
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
        return { requested: 0 };
      },
    } as unknown as RequestDailyPullRequestRefreshesHandler;
    const schedule = new DailyPullRequestRefreshScheduler(slow, SETTINGS);

    const first = schedule.tick();
    await schedule.tick();
    release();
    await first;

    expect(passes).toBe(1);
  });
});
