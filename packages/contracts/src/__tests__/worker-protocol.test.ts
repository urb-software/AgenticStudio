import { describe, expect, it } from 'vitest';
import {
  claimRunRequestSchema,
  jsonByteLength,
  RUN_STEP_RESULT_MAX_BYTES,
  heartbeatRequestSchema,
  reportRunStateRequestSchema,
  reportRunStepRequestSchema,
  runnerEventSchema,
  runPayloadSchema,
  runStepResultSchema,
  PROVIDER_NAMES,
  PROVIDERS,
  providerSwitchesSchema,
  TASK_MAX_LENGTH,
  workerStatusRequestSchema,
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
  it('is a typed line of text', () => {
    expect(runnerEventSchema.parse({ type: 'output', text: 'compiling' })).toEqual({
      type: 'output',
      text: 'compiling',
    });
    expect(runnerEventSchema.safeParse({ type: 'secret', text: '' }).success).toBe(false);
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

describe('worker status report (Issue #101)', () => {
  const report = {
    workerId: WORKER_ID,
    runner: 'cli',
    providers: { claude_code: true, codex: false },
  };

  it('has one switch and one display name for every provider, and nothing else', () => {
    expect(Object.keys(providerSwitchesSchema.shape)).toEqual([...PROVIDERS]);
    expect(PROVIDER_NAMES).toEqual({ claude_code: 'Claude Code', codex: 'Codex' });
  });

  it('carries the runner mode and one switch per provider', () => {
    expect(workerStatusRequestSchema.parse(report)).toEqual(report);
    expect(workerStatusRequestSchema.safeParse({ ...report, runner: 'fake' }).success).toBe(true);
  });

  it.each([
    ['an unknown runner mode', { ...report, runner: 'api' }],
    ['a missing provider', { ...report, providers: { claude_code: true } }],
    ['an unknown provider', { ...report, providers: { ...report.providers, gpt: true } }],
    [
      'a switch that is not a boolean',
      { ...report, providers: { claude_code: 'true', codex: false } },
    ],
    ['an extra field', { ...report, environment: 'production' }],
    ['no worker id', { runner: 'cli', providers: report.providers }],
  ])('refuses %s', (_case, body) => {
    expect(workerStatusRequestSchema.safeParse(body).success).toBe(false);
  });
});
