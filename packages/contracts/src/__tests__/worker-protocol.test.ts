import { describe, expect, it } from 'vitest';
import {
  appendRunEventsRequestSchema,
  claimRunRequestSchema,
  cutToBytes,
  jsonByteLength,
  RUN_STEP_RESULT_MAX_BYTES,
  heartbeatRequestSchema,
  reportRunStateRequestSchema,
  reportRunStepRequestSchema,
  RUN_EVENT_BATCH_MAX,
  RUN_EVENT_KINDS,
  RUN_EVENT_TEXT_MAX_BYTES,
  runnerEventSchema,
  runPayloadSchema,
  runStepResultSchema,
  TASK_MAX_LENGTH,
} from '../index.js';

// Issue #96: the worker protocol is defined once here and shared by the API and the agent
// worker. These tests pin the shapes both sides rely on.

const WORKER_ID = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const PROJECT_ID = '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b';

describe('run payload (claim response)', () => {
  const payload = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    provider: 'claude_code',
    task: 'Add a health check',
    startCommit: 'a'.repeat(40),
  };

  it('accepts exactly what a Run needs', () => {
    expect(runPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects an extra field, so nothing else can travel to the worker by accident', () => {
    expect(runPayloadSchema.safeParse({ ...payload, deployKey: 'x' }).success).toBe(false);
  });

  it('accepts both providers and nothing else', () => {
    expect(runPayloadSchema.safeParse({ ...payload, provider: 'codex' }).success).toBe(true);
    expect(runPayloadSchema.safeParse({ ...payload, provider: 'gpt' }).success).toBe(false);
  });

  it('limits the Task to 1-20 000 characters', () => {
    expect(TASK_MAX_LENGTH).toBe(20_000);
    expect(runPayloadSchema.safeParse({ ...payload, task: '' }).success).toBe(false);
    expect(runPayloadSchema.safeParse({ ...payload, task: 'x'.repeat(20_001) }).success).toBe(
      false,
    );
  });
});

describe('worker requests', () => {
  it('identifies the worker by a UUID on every request', () => {
    expect(claimRunRequestSchema.parse({ workerId: WORKER_ID })).toEqual({ workerId: WORKER_ID });
    expect(heartbeatRequestSchema.parse({ workerId: WORKER_ID })).toEqual({ workerId: WORKER_ID });
    expect(claimRunRequestSchema.safeParse({ workerId: 'worker-1' }).success).toBe(false);
    expect(heartbeatRequestSchema.safeParse({}).success).toBe(false);
  });

  it('reports only the states a worker reaches, with a failure exactly when failed', () => {
    const report = (body: object) =>
      reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, ...body }).success;

    expect(report({ state: 'running' })).toBe(true);
    expect(report({ state: 'waiting_for_operator' })).toBe(true);
    expect(report({ state: 'succeeded' })).toBe(true);
    expect(report({ state: 'failed', failure: { code: 'agent_failed', detail: 'exit 1' } })).toBe(
      true,
    );

    expect(report({ state: 'failed' })).toBe(false);
    expect(report({ state: 'succeeded', failure: { code: 'unknown', detail: '' } })).toBe(false);
    expect(report({ state: 'queued' })).toBe(false);
    expect(report({ state: 'cancelled' })).toBe(false);
    expect(report({ state: 'failed', failure: { code: 'oops', detail: '' } })).toBe(false);
  });

  it('caps a failure detail at 2000 characters', () => {
    const failure = { code: 'agent_failed', detail: 'x'.repeat(2001) };
    expect(
      reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, state: 'failed', failure })
        .success,
    ).toBe(false);
  });

  it('reports a Run step of kind start or resume with its structured result', () => {
    const result = { outcome: 'done', summary: 'Done.' };
    expect(
      reportRunStepRequestSchema.parse({ workerId: WORKER_ID, kind: 'start', result }),
    ).toEqual({ workerId: WORKER_ID, kind: 'start', result });
    expect(
      reportRunStepRequestSchema.safeParse({ workerId: WORKER_ID, kind: 'retry', result }).success,
    ).toBe(false);
  });
});

describe('structured result of a Run step', () => {
  it('accepts a full done result', () => {
    const result = {
      outcome: 'done',
      summary: 'Added the endpoint.',
      pullRequest: { title: 'Add health check', body: 'Adds GET /health.' },
      checks: [
        { name: 'unit tests', result: 'passed' },
        { name: 'lint', result: 'failed', detail: '2 warnings' },
        { name: 'e2e', result: 'not_run' },
      ],
    };
    expect(runStepResultSchema.parse(result)).toEqual(result);
  });

  it('needs a question when the agent needs input', () => {
    expect(
      runStepResultSchema.safeParse({ outcome: 'needs_input', summary: 'Stuck.' }).success,
    ).toBe(false);
    expect(
      runStepResultSchema.safeParse({
        outcome: 'needs_input',
        summary: 'Stuck.',
        question: 'Which database?',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown outcome or check result', () => {
    expect(runStepResultSchema.safeParse({ outcome: 'maybe', summary: '' }).success).toBe(false);
    expect(
      runStepResultSchema.safeParse({
        outcome: 'done',
        summary: '',
        checks: [{ name: 'x', result: 'green' }],
      }).success,
    ).toBe(false);
  });
});

describe('runner event', () => {
  it('is an agent message, a command or output (Issue #99)', () => {
    expect(runnerEventSchema.parse({ type: 'output', text: 'compiling' })).toEqual({
      type: 'output',
      text: 'compiling',
    });
    for (const type of ['message', 'command', 'output']) {
      expect(runnerEventSchema.safeParse({ type, text: 'x' }).success).toBe(true);
    }
    expect(runnerEventSchema.safeParse({ type: 'status', text: '' }).success).toBe(false);
    expect(runnerEventSchema.safeParse({ type: 'notice', text: '' }).success).toBe(false);
  });
});

describe('appending Run events (Issue #99)', () => {
  const event = (seq: number, overrides: object = {}) => ({
    seq,
    at: '2026-11-15T12:00:00.000Z',
    stepIndex: 1,
    kind: 'output',
    text: `line ${seq}`,
    ...overrides,
  });

  it('accepts a batch of events in sequence order, of every kind', () => {
    const events = RUN_EVENT_KINDS.map((kind, index) => event(index + 1, { kind }));
    expect(appendRunEventsRequestSchema.parse({ workerId: WORKER_ID, events })).toEqual({
      workerId: WORKER_ID,
      events,
    });
    expect(RUN_EVENT_KINDS).toEqual([
      'message',
      'command',
      'output',
      'step_started',
      'step_finished',
      'notice',
    ]);
  });

  it('accepts a gap in the sequence and an event the worker already cut', () => {
    const events = [event(1), event(5, { truncated: true })];
    expect(appendRunEventsRequestSchema.safeParse({ workerId: WORKER_ID, events }).success).toBe(
      true,
    );
  });

  it.each([
    ['no events', []],
    [
      'more events than a batch holds',
      Array.from({ length: RUN_EVENT_BATCH_MAX + 1 }, (_, i) => event(i + 1)),
    ],
    ['a sequence that goes back', [event(2), event(1)]],
    ['a repeated sequence number', [event(1), event(1)]],
    ['a sequence number below 1', [event(0)]],
    ['a step index below 1', [event(1, { stepIndex: 0 })]],
    ['an unknown kind', [event(1, { kind: 'status' })]],
    ['a timestamp that is not ISO 8601', [event(1, { at: 'yesterday' })]],
    [
      'a text longer than the event cap',
      [event(1, { text: 'x'.repeat(RUN_EVENT_TEXT_MAX_BYTES + 1) })],
    ],
    ['an extra field', [event(1, { secret: 'x' })]],
  ])('rejects %s', (_case, events) => {
    expect(appendRunEventsRequestSchema.safeParse({ workerId: WORKER_ID, events }).success).toBe(
      false,
    );
  });

  it('fits one event of the largest text in the API body limit, even as escaped JSON', () => {
    // The worker splits batches by size; one event alone, its text at the cap and every
    // character a control character (six bytes as JSON), still fits 100 KiB.
    const body = {
      workerId: WORKER_ID,
      events: [event(1, { text: '\u0001'.repeat(RUN_EVENT_TEXT_MAX_BYTES), truncated: true })],
    };
    expect(jsonByteLength(body)).toBeLessThan(100 * 1024);
  });
});

describe('cutting text to a number of UTF-8 bytes', () => {
  it('keeps a text that fits', () => {
    expect(cutToBytes('héllo', 6)).toEqual({ text: 'héllo', cut: false });
  });

  it('cuts at a character boundary, never inside a multi-byte character', () => {
    expect(cutToBytes('héllo', 2)).toEqual({ text: 'h', cut: true });
    expect(cutToBytes('héllo', 3)).toEqual({ text: 'hé', cut: true });
    expect(cutToBytes('a😀b', 4)).toEqual({ text: 'a', cut: true });
    expect(cutToBytes('a😀b', 5)).toEqual({ text: 'a😀', cut: true });
  });
});

describe('size of a structured result (review finding 4 on #111)', () => {
  /** A valid result of exactly `bytes` bytes of JSON, every field near its own limit. */
  function resultOf(bytes: number) {
    const result = {
      outcome: 'done' as const,
      summary: 's'.repeat(20_000),
      pullRequest: { title: 't'.repeat(256), body: 'b'.repeat(65_536) },
      checks: [] as { name: string; result: 'passed'; detail: string }[],
    };
    for (;;) {
      const check = { name: 'check', result: 'passed' as const, detail: '' };
      result.checks.push(check);
      const room = bytes - jsonByteLength(result);
      check.detail = 'd'.repeat(Math.min(room, 4000));
      if (room <= 4000) return result;
    }
  }

  it('accepts a result of exactly the maximum size', () => {
    const result = resultOf(RUN_STEP_RESULT_MAX_BYTES);
    expect(jsonByteLength(result)).toBe(RUN_STEP_RESULT_MAX_BYTES);
    expect(runStepResultSchema.safeParse(result).success).toBe(true);
  });

  it('refuses one byte more, though every field is within its own limit', () => {
    expect(runStepResultSchema.safeParse(resultOf(RUN_STEP_RESULT_MAX_BYTES + 1)).success).toBe(
      false,
    );
  });

  it('counts bytes, not characters: multi-byte text fills the budget sooner', () => {
    const result = { outcome: 'done', summary: 'é'.repeat(20_000) };
    expect(jsonByteLength(result)).toBeGreaterThan(40_000);
  });

  it('leaves room for the step report around a maximal result under the 100 KiB body limit', () => {
    const body = {
      workerId: WORKER_ID,
      kind: 'resume',
      result: resultOf(RUN_STEP_RESULT_MAX_BYTES),
    };
    expect(jsonByteLength(body)).toBeLessThan(100 * 1024);
  });
});
