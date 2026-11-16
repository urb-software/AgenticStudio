import { RUN_EVENT_TEXT_MAX_BYTES } from '@agentic-studio/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../../../domain/entities/run.js';
import { LOG_TRUNCATED_NOTICE } from '../../../domain/entities/run-event.js';
import { InMemoryRunLogRepository } from '../../../domain/repositories/__tests__/in-memory-run-log-repository.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunNotFoundError, RunNotHeldError } from '../../../domain/repositories/run-repository.js';
import { REDACTED } from '../../../domain/services/log-redaction.js';
import { AppendRunEventsHandler, type AppendRunEventsInput } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const AT = '2026-11-15T12:00:01.000Z';

type InputEvent = AppendRunEventsInput['events'][number];
const event = (seq: number, text = `line ${seq}`, overrides: Partial<InputEvent> = {}) => ({
  seq,
  at: AT,
  stepIndex: 1,
  kind: 'output' as const,
  text,
  ...overrides,
});

describe('AppendRunEventsHandler', () => {
  let runs: InMemoryRunRepository;
  let log: InMemoryRunLogRepository;
  let notified: string[];
  let secrets: string[];
  let handler: AppendRunEventsHandler;
  let run: Run;

  const append = (events: InputEvent[], workerId = WORKER) =>
    handler.execute({ runId: run.id, workerId, events });
  const stored = () => log.events.get(run.id) ?? [];

  function build(maxBytes = 1024) {
    handler = new AppendRunEventsHandler(
      runs,
      log,
      { forRun: (runId) => Promise.resolve(runId === run.id ? secrets : []) },
      { maxBytes, keepAliveMs: 15_000, streamsPerSession: 5, streamsTotal: 50 },
      { notify: (runId) => notified.push(runId), subscribe: () => () => undefined },
    );
  }

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    log = new InMemoryRunLogRepository(runs);
    notified = [];
    secrets = [];
    await runs.add({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });
    run = (await runs.claimNext(WORKER, T0))!;
    build();
  });

  it('stores the events of a held Run by sequence number and wakes its streams', async () => {
    expect(await append([event(1), event(2, 'pnpm test', { kind: 'command' })])).toBe(2);

    expect(stored()).toEqual([
      { seq: 1, at: new Date(AT), stepIndex: 1, kind: 'output', text: 'line 1', truncated: false },
      {
        seq: 2,
        at: new Date(AT),
        stepIndex: 1,
        kind: 'command',
        text: 'pnpm test',
        truncated: false,
      },
    ]);
    expect(notified).toEqual([run.id]);
  });

  it('ignores a re-sent batch and accepts a gap', async () => {
    await append([event(1), event(2)]);

    expect(await append([event(1), event(2), event(5)])).toBe(1);
    expect(stored().map((stored) => stored.seq)).toEqual([1, 2, 5]);
  });

  it('redacts known secret values and token-shaped strings before storing', async () => {
    secrets = ['test-db-password'];
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

    await append([event(1, `DB=test-db-password TOKEN=${token}`)]);

    expect(stored()[0]!.text).toBe(`DB=${REDACTED} TOKEN=${REDACTED}`);
  });

  it('cuts a text over the per-event cap after redaction and marks it truncated', async () => {
    build(1_000_000);
    secrets = ['abcd'];

    await append([
      event(1, 'abcd'.repeat(RUN_EVENT_TEXT_MAX_BYTES / 4)),
      event(2, 'x', { truncated: true }),
    ]);

    const [first, second] = stored();
    expect(Buffer.byteLength(first!.text)).toBeLessThanOrEqual(RUN_EVENT_TEXT_MAX_BYTES);
    expect(first!.text.startsWith(REDACTED)).toBe(true);
    expect(first!.truncated).toBe(true);
    expect(second!.truncated).toBe(true);
  });

  it('stores one "log truncated" notice at the per-Run cap and drops later events', async () => {
    build(10);

    await append([event(1, '12345'), event(2, '67890'), event(3, 'over')]);
    await append([event(4, 'more')]);

    expect(stored().map(({ seq, kind, text }) => ({ seq, kind, text }))).toEqual([
      { seq: 1, kind: 'output', text: '12345' },
      { seq: 2, kind: 'output', text: '67890' },
      { seq: 3, kind: 'notice', text: LOG_TRUNCATED_NOTICE },
    ]);
  });

  it('rejects events from a worker that does not hold the Run, and after it was released', async () => {
    await expect(append([event(1)], OTHER_WORKER)).rejects.toBeInstanceOf(RunNotHeldError);

    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'unknown', detail: 'x' },
      cancelRequested: false,
      now: T0,
    });
    await expect(append([event(1)])).rejects.toBeInstanceOf(RunNotHeldError);
    expect(stored()).toEqual([]);
    expect(notified).toEqual([]);
  });

  it('rejects an unknown Run', async () => {
    await expect(
      handler.execute({ runId: 'nope', workerId: WORKER, events: [event(1)] }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
