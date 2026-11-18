import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunSnapshot } from '../../../../domain/entities/run-snapshot.js';
import type { RunEvent } from '../../../../domain/value-objects/run-event.js';
import { InMemoryRunLog } from '../../../../application/ports/__tests__/in-memory-run-log.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import type { RunLogSignal } from '../../../ports/run-log-signal.js';
import { ListRunEventsHandler } from '../../list-run-events/handler.js';
import { KEEP_ALIVE, type RunLogStreamItem, StreamRunEventsHandler } from '../handler.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');

const event = (seq: number): RunEvent => ({
  seq,
  at: T0,
  stepIndex: 1,
  kind: 'output',
  text: `line ${seq}`,
  truncated: false,
});

class TestSignal implements RunLogSignal {
  private readonly emitter = new EventEmitter();
  notify(runId: string) {
    this.emitter.emit(runId);
  }
  subscribe(runId: string, listener: () => void) {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
  listeners(runId: string) {
    return this.emitter.listenerCount(runId);
  }
}

async function take(stream: AsyncGenerator<RunLogStreamItem>, count: number) {
  const items: (number | typeof KEEP_ALIVE)[] = [];
  while (items.filter((item) => item !== KEEP_ALIVE).length < count) {
    const next = await stream.next();
    if (next.done) break;
    if (next.value === KEEP_ALIVE) items.push(KEEP_ALIVE);
    else items.push(...next.value.map((stored) => stored.seq));
  }
  return items;
}

describe('a Run log, paged and live', () => {
  let runs: InMemoryRunRepository;
  let log: InMemoryRunLog;
  let signal: TestSignal;
  let run: RunSnapshot;

  const append = async (...seqs: number[]) => {
    await log.append(run.id, WORKER, seqs.map(event), 1_000_000);
    signal.notify(run.id);
  };
  const finish = async () => {
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'unknown', detail: 'x' },
      cancelRequested: false,
      now: T0,
    });
    signal.notify(run.id);
  };
  const streams = (keepAliveMs = 60_000) =>
    new StreamRunEventsHandler(runs, log, signal, {
      maxBytes: 1_000_000,
      keepAliveMs,
      streamsPerSession: 5,
      streamsTotal: 50,
    });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    log = new InMemoryRunLog(runs);
    signal = new TestSignal();
    await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });
    run = (await runs.claimNext(WORKER, T0))!.snapshot();
  });

  describe('paging', () => {
    it('returns the events after a seq, with the next cursor while more follow', async () => {
      await append(1, 2, 3, 4, 5);
      const pages = new ListRunEventsHandler(runs, log);

      const first = await pages.execute({ runId: run.id, after: 0, limit: 2 });
      expect(first.events.map((stored) => stored.seq)).toEqual([1, 2]);
      expect(first.next).toBe(2);
      const last = await pages.execute({ runId: run.id, after: 4, limit: 2 });
      expect(last).toEqual({ events: [event(5)] });
      expect(await pages.execute({ runId: run.id, after: 2, limit: 3 })).toEqual({
        events: [event(3), event(4), event(5)],
      });
    });

    it('rejects an unknown Run', async () => {
      await expect(
        new ListRunEventsHandler(runs, log).execute({ runId: 'nope', after: 0, limit: 1 }),
      ).rejects.toBeInstanceOf(RunNotFoundError);
    });
  });

  describe('streaming', () => {
    it('catches up from the store, then follows new events live until the Run is final', async () => {
      await append(1, 2);
      const stream = (
        await streams().execute({ runId: run.id, after: 0, abort: new AbortController().signal })
      ).stream;

      expect(await take(stream, 2)).toEqual([1, 2]);
      const live = take(stream, 2);
      await append(3);
      await append(4);
      expect(await live).toEqual([3, 4]);
      await finish();
      expect((await stream.next()).done).toBe(true);
      expect(signal.listeners(run.id)).toBe(0);
    });

    it('resumes after a seq without repeating what the client saw', async () => {
      await append(1, 2, 3);
      await finish();

      const stream = (
        await streams().execute({ runId: run.id, after: 2, abort: new AbortController().signal })
      ).stream;

      expect(await take(stream, 10)).toEqual([3]);
    });

    it('sends events appended between the state read and the wait (no lost wake-up)', async () => {
      const stream = (
        await streams().execute({ runId: run.id, after: 0, abort: new AbortController().signal })
      ).stream;
      const first = stream.next();
      await append(1);
      expect(await first).toMatchObject({ value: [event(1)] });
    });

    it('sends a keep-alive when idle, and stops when the client goes away', async () => {
      const abort = new AbortController();
      const { stream } = await streams(5).execute({ runId: run.id, after: 0, abort: abort.signal });

      expect((await stream.next()).value).toBe(KEEP_ALIVE);
      abort.abort();
      expect((await stream.next()).done).toBe(true);
      expect(signal.listeners(run.id)).toBe(0);
    });

    it('rejects an unknown Run before streaming', async () => {
      await expect(
        streams().execute({ runId: 'nope', after: 0, abort: new AbortController().signal }),
      ).rejects.toBeInstanceOf(RunNotFoundError);
    });
  });
});
