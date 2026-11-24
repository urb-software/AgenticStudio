import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResumeDisconnectsHandler } from '../../../application/features/resume-disconnects/handler.js';
import { RepositoryDisconnectsScheduler } from '../repository-disconnects.js';

const handler = (execute: () => Promise<void>) =>
  ({ execute }) as unknown as ResumeDisconnectsHandler;

describe('RepositoryDisconnectsScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries the disconnects on a timer from the start until shutdown', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => Promise.resolve());
    const scheduler = new RepositoryDisconnectsScheduler(handler(execute), {
      enabled: true,
      intervalMs: 30_000,
    });

    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(execute).toHaveBeenCalledTimes(2);

    scheduler.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('starts no timer while it is turned off', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => Promise.resolve());
    const scheduler = new RepositoryDisconnectsScheduler(handler(execute), {
      enabled: false,
      intervalMs: 30_000,
    });

    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(execute).not.toHaveBeenCalled();
  });

  it('does not start a second run while one is going', async () => {
    let release: () => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const scheduler = new RepositoryDisconnectsScheduler(handler(execute), {
      enabled: true,
      intervalMs: 30_000,
    });

    const first = scheduler.tick();
    await scheduler.tick();
    release();
    await first;

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('logs a failure redacted and runs again at the next interval', async () => {
    const errors: unknown[][] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const execute = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED postgres://studio:hunter2@db:5432'))
      .mockResolvedValue(undefined);
    const scheduler = new RepositoryDisconnectsScheduler(handler(execute), {
      enabled: true,
      intervalMs: 30_000,
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errors)).not.toContain('hunter2');
    expect(errors).toHaveLength(1);
  });
});
