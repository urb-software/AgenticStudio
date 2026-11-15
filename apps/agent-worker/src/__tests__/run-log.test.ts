import { RUN_EVENT_TEXT_MAX_BYTES, type RunEventInput } from '@agentic-studio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunLog, WORKER_BUFFER_NOTICE } from '../run-log.js';
import { StudioApiError } from '../studio-api.js';

// Issue #99: the worker forwards a Run's events to Studio in small batches, in order, and
// survives short interruptions without loss or duplication.
const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a11';
const silent = { info: () => undefined, error: () => undefined };

class RecordingApi {
  readonly batches: RunEventInput[][] = [];
  failures: Error[] = [];

  async appendEvents(runId: string, events: RunEventInput[]) {
    expect(runId).toBe(RUN_ID);
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.batches.push(structuredClone(events));
  }
  delivered() {
    return this.batches.flat();
  }
}

describe('RunLog', () => {
  let api: RecordingApi;
  let lost: number;
  let log: RunLog;

  const create = (options: Partial<ConstructorParameters<typeof RunLog>[0]> = {}) => {
    log = new RunLog({
      api,
      runId: RUN_ID,
      logger: silent,
      onLost: () => lost++,
      ...options,
    });
    return log;
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-15T12:00:00.000Z') });
    api = new RecordingApi();
    lost = 0;
  });

  afterEach(() => {
    log?.dispose();
    vi.useRealTimers();
  });

  it('numbers events per Run from 1 and sends them every 500 ms', async () => {
    create();
    log.push(1, 'step_started', 'Run step 1 started');
    log.push(1, 'command', 'pnpm test');

    await vi.advanceTimersByTimeAsync(499);
    expect(api.batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.batches).toEqual([
      [
        {
          seq: 1,
          at: '2026-11-15T12:00:00.000Z',
          stepIndex: 1,
          kind: 'step_started',
          text: 'Run step 1 started',
        },
        {
          seq: 2,
          at: '2026-11-15T12:00:00.000Z',
          stepIndex: 1,
          kind: 'command',
          text: 'pnpm test',
        },
      ],
    ]);
  });

  it('sends at once when 100 events are waiting, never more than 100 in a batch', async () => {
    create();
    for (let i = 0; i < 250; i++) log.push(1, 'output', `line ${i}`);

    await vi.advanceTimersByTimeAsync(0);
    expect(api.batches.length).toBeGreaterThanOrEqual(2);
    await log.close();
    expect(api.batches.every((batch) => batch.length <= 100)).toBe(true);
    expect(api.delivered().map((event) => event.seq)).toEqual(
      Array.from({ length: 250 }, (_, i) => i + 1),
    );
  });

  it('splits batches by size so each request fits the API body limit', async () => {
    create();
    for (let i = 0; i < 10; i++) log.push(1, 'output', 'x'.repeat(RUN_EVENT_TEXT_MAX_BYTES));

    await log.close();

    expect(api.delivered()).toHaveLength(10);
    for (const batch of api.batches) {
      expect(new TextEncoder().encode(JSON.stringify({ events: batch })).length).toBeLessThan(
        90 * 1024,
      );
    }
  });

  it('retries with backoff after a failed send, without losing or repeating events', async () => {
    create();
    api.failures = [new Error('ECONNREFUSED'), new StudioApiError(503, '/api/worker/x')];
    log.push(1, 'output', 'a');
    log.push(1, 'output', 'b');

    await vi.advanceTimersByTimeAsync(500);
    expect(api.batches).toEqual([]);
    log.push(1, 'output', 'c');
    await vi.advanceTimersByTimeAsync(5000);

    expect(api.delivered().map((event) => event.text)).toEqual(['a', 'b', 'c']);
    expect(api.delivered().map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('cuts a text longer than the event cap and marks it truncated', async () => {
    create();
    log.push(1, 'output', 'é'.repeat(RUN_EVENT_TEXT_MAX_BYTES));

    await log.close();

    const [event] = api.delivered();
    expect(new TextEncoder().encode(event!.text).length).toBe(RUN_EVENT_TEXT_MAX_BYTES);
    expect(event!.truncated).toBe(true);
  });

  it('on buffer overflow drops further output with one notice, but keeps the step markers', async () => {
    create({ bufferMax: 3 });
    api.failures = Array.from({ length: 3 }, () => new Error('down'));
    log.push(1, 'step_started', 'Run step 1 started');
    log.push(1, 'output', 'a');
    log.push(1, 'output', 'b');
    log.push(1, 'output', 'dropped');
    log.push(1, 'output', 'dropped too');
    log.push(1, 'step_finished', 'Run step 1 finished: done');

    const closed = log.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await closed;

    expect(api.delivered().map(({ seq, kind, text }) => [seq, kind, text])).toEqual([
      [1, 'step_started', 'Run step 1 started'],
      [2, 'output', 'a'],
      [3, 'output', 'b'],
      [4, 'notice', WORKER_BUFFER_NOTICE],
      [5, 'step_finished', 'Run step 1 finished: done'],
    ]);
    expect(WORKER_BUFFER_NOTICE).toBe('log truncated (worker buffer)');
  });

  it('stops forwarding when Studio says the worker no longer holds the Run', async () => {
    create();
    api.failures = [new StudioApiError(409, '/api/worker/runs/x/events')];
    log.push(1, 'output', 'a');

    await vi.advanceTimersByTimeAsync(500);
    log.push(1, 'output', 'b');
    await log.close();

    expect(lost).toBe(1);
    expect(api.batches).toEqual([]);
  });

  it('on close gives up after its deadline while Studio stays unreachable', async () => {
    create();
    api.failures = Array.from({ length: 1000 }, () => new Error('down'));
    log.push(1, 'output', 'a');

    const closed = log.close(3000);
    await vi.advanceTimersByTimeAsync(20_000);
    await closed;

    expect(api.batches).toEqual([]);
  });
});
