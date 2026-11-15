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
  RUN_STATES,
  runStatesRequestSchema,
  runStatesResponseSchema,
  runStepResultSchema,
  TASK_MAX_LENGTH,
  WORKER_REQUEST_MAX_BYTES,
  WORKING_COPY_COMMITS_MAX,
  WORKING_COPY_REPORT_MAX_BYTES,
  workingCopyReportSchema,
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
    repository: { remoteUrl: 'git@github.com:acme/shop.git' },
  };

  it('accepts exactly what a Run needs', () => {
    expect(runPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("carries the Repository's remote URL and nothing else about it (Issue #98)", () => {
    const withRepository = (repository: object) =>
      runPayloadSchema.safeParse({ ...payload, repository }).success;

    expect(withRepository({ remoteUrl: 'https://github.com/acme/shop.git' })).toBe(true);
    expect(withRepository({ remoteUrl: '' })).toBe(false);
    expect(withRepository({ remoteUrl: 'x'.repeat(2049) })).toBe(false);
    expect(withRepository({ remoteUrl: 'https://github.com/acme/shop.git', deployKey: 'k' })).toBe(
      false,
    );
    expect(runPayloadSchema.safeParse({ ...payload, repository: undefined }).success).toBe(false);
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

  it("carries a failed Run's Working copy state, and only with the state failed (Issue #98)", () => {
    const workingCopy = {
      runBranch: 'agent/x-r0b8e5c2d',
      commits: [{ id: 'c'.repeat(40), subject: 'Half done' }],
      hasUncommittedChanges: true,
    };
    const failure = { code: 'agent_failed', detail: 'exit 1' };
    const report = (body: object) =>
      reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, ...body }).success;

    expect(report({ state: 'failed', failure, workingCopy })).toBe(true);
    expect(report({ state: 'failed', failure })).toBe(true);
    expect(report({ state: 'succeeded', workingCopy })).toBe(false);
    expect(report({ state: 'running', workingCopy })).toBe(false);
    expect(
      report({ state: 'failed', failure, workingCopy: { ...workingCopy, commits: [{ id: 'x' }] } }),
    ).toBe(false);
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
    const workingCopy = {
      runBranch: 'agent/x-r0b8e5c2d',
      commits: [],
      hasUncommittedChanges: false,
    };
    const body = { workerId: WORKER_ID, kind: 'start', result, workingCopy };
    expect(reportRunStepRequestSchema.parse(body)).toEqual(body);
    expect(reportRunStepRequestSchema.safeParse({ ...body, kind: 'retry' }).success).toBe(false);
  });

  it("carries the Working copy's state with every Run step report (Issue #98)", () => {
    const result = { outcome: 'done', summary: 'Done.' };
    expect(
      reportRunStepRequestSchema.safeParse({ workerId: WORKER_ID, kind: 'start', result }).success,
    ).toBe(false);
  });

  it('asks for the states of 1-500 Run ids (Issue #98)', () => {
    const ask = (runIds: unknown) =>
      runStatesRequestSchema.safeParse({ workerId: WORKER_ID, runIds }).success;

    expect(ask([RUN_ID])).toBe(true);
    expect(ask(Array.from({ length: 500 }, () => RUN_ID))).toBe(true);
    expect(ask([])).toBe(false);
    expect(ask(Array.from({ length: 501 }, () => RUN_ID))).toBe(false);
    expect(ask(['../../etc'])).toBe(false);
  });

  it('answers with the state of each known Run and when it finished', () => {
    const answer = [
      { runId: RUN_ID, state: 'succeeded', finishedAt: '2026-11-15T10:00:00.000Z' },
      { runId: PROJECT_ID, state: 'running', finishedAt: null },
    ];
    expect(runStatesResponseSchema.parse(answer)).toEqual(answer);
    expect(
      runStatesResponseSchema.safeParse([{ runId: RUN_ID, state: 'gone', finishedAt: null }])
        .success,
    ).toBe(false);
    expect(RUN_STATES).toContain('waiting_for_operator');
  });
});

describe('Working copy report (Issue #98)', () => {
  const commit = (n: number) => ({ id: n.toString(16).padStart(40, '0'), subject: `Commit ${n}` });
  const reportOf = (commits: unknown[]) => ({
    runBranch: 'agent/x-r0b8e5c2d',
    commits,
    hasUncommittedChanges: false,
  });

  it('names the Run branch, the commits since the start commit and uncommitted changes', () => {
    const report = {
      runBranch: 'agent/add-pagination-r0b8e5c2d',
      commits: [commit(1), commit(2)],
      hasUncommittedChanges: true,
    };
    expect(workingCopyReportSchema.parse(report)).toEqual(report);
  });

  it('accepts SHA-1 and SHA-256 commit ids and nothing else', () => {
    const withId = (id: string) =>
      workingCopyReportSchema.safeParse(reportOf([{ id, subject: 's' }])).success;

    expect(withId('a'.repeat(40))).toBe(true);
    expect(withId('b'.repeat(64))).toBe(true);
    expect(withId('abc')).toBe(false);
    expect(withId('A'.repeat(40))).toBe(false);
  });

  it('caps the commits at 200, a subject at 200 characters and the report at its byte budget', () => {
    expect(WORKING_COPY_COMMITS_MAX).toBe(200);
    const valid = (commits: unknown[]) =>
      workingCopyReportSchema.safeParse(reportOf(commits)).success;

    expect(valid(Array.from({ length: 200 }, (_, n) => commit(n)))).toBe(true);
    expect(valid(Array.from({ length: 201 }, (_, n) => commit(n)))).toBe(false);
    expect(valid([{ id: commit(1).id, subject: 's'.repeat(201) }])).toBe(false);
    // Two-byte characters: 200 commits within every field limit, yet over the byte budget.
    const wide = Array.from({ length: 200 }, (_, n) => ({
      id: commit(n).id,
      subject: 'ж'.repeat(200),
    }));
    expect(jsonByteLength(reportOf(wide))).toBeGreaterThan(WORKING_COPY_REPORT_MAX_BYTES);
    expect(valid(wide)).toBe(false);
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

  it('leaves room for a maximal step report under the request body limit (Issue #98)', () => {
    // Every field at its limit: 200 commits with SHA-256 ids and 200-character subjects.
    const workingCopy = {
      runBranch: `agent/${'b'.repeat(40)}-r0b8e5c2d`,
      commits: Array.from({ length: 200 }, () => ({
        id: 'c'.repeat(64),
        subject: 's'.repeat(200),
      })),
      hasUncommittedChanges: true,
    };
    const body = {
      workerId: WORKER_ID,
      kind: 'resume',
      result: resultOf(RUN_STEP_RESULT_MAX_BYTES),
      workingCopy,
    };
    expect(reportRunStepRequestSchema.safeParse(body).success).toBe(true);
    expect(jsonByteLength(body)).toBeLessThan(WORKER_REQUEST_MAX_BYTES);
    expect(WORKER_REQUEST_MAX_BYTES).toBe(192 * 1024);
  });
});
