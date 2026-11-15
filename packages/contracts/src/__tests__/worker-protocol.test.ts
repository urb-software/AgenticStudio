import { describe, expect, it } from 'vitest';
import {
  ANSWER_MAX_LENGTH,
  appendRunEventsRequestSchema,
  QUESTION_OPTION_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  SESSION_REF_MAX_LENGTH,
  claimRunRequestSchema,
  cutToBytes,
  jsonByteLength,
  RUN_STEP_RESULT_MAX_BYTES,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  RUN_FAILURE_CODES,
  runLimitsSchema,
  reportRunStateRequestSchema,
  reportRunStepRequestSchema,
  RUN_EVENT_BATCH_MAX,
  RUN_EVENT_KINDS,
  RUN_EVENT_TEXT_MAX_BYTES,
  runnerEventSchema,
  runPayloadSchema,
  RUN_STATES,
  runStatesRequestSchema,
  runStatesResponseSchema,
  runStepResultSchema,
  PROVIDER_NAMES,
  PROVIDERS,
  providerSwitchesSchema,
  TASK_MAX_LENGTH,
  WORKER_REQUEST_MAX_BYTES,
  WORKING_COPY_COMMITS_MAX,
  WORKING_COPY_REPORT_MAX_BYTES,
  workingCopyReportSchema,
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
    repository: { remoteUrl: 'git@github.com:acme/shop.git' },
    integrationBranch: 'dev',
    kind: 'start',
    studioPaths: [],
    limits: { stepMinutes: 60, maxSteps: 10 },
    completedSteps: 0,
  };

  it('accepts exactly what a Run needs', () => {
    expect(runPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('hands out a Run to start or, after a retry request, only to deliver (Issue #102)', () => {
    const withKind = (kind: unknown) => runPayloadSchema.safeParse({ ...payload, kind }).success;

    expect(withKind('start')).toBe(true);
    expect(withKind('deliver')).toBe(false);
    expect(
      runPayloadSchema.safeParse({ ...payload, kind: 'deliver', runBranch: 'agent/x-r0b8e5c2d' })
        .success,
    ).toBe(true);
    expect(withKind('resume')).toBe(false);
    expect(withKind(undefined)).toBe(false);
  });

  describe('a resume claim (Issue #103)', () => {
    const resume = {
      ...payload,
      kind: 'resume',
      runBranch: 'agent/x-r0b8e5c2d',
      sessionRef: 'session-1',
      answer: 'Use PostgreSQL.',
      nextSeq: 42,
      completedSteps: 1,
    };

    it("carries the session reference, the operator's answer, the next seq and the Run branch", () => {
      expect(runPayloadSchema.parse(resume)).toEqual(resume);
    });

    it('needs all four, and only a resume claim carries the session, answer and seq', () => {
      for (const field of ['runBranch', 'sessionRef', 'answer', 'nextSeq'] as const) {
        const { [field]: _left, ...without } = resume;
        void _left;
        expect(runPayloadSchema.safeParse(without).success).toBe(false);
      }
      for (const field of ['sessionRef', 'answer', 'nextSeq'] as const) {
        expect(runPayloadSchema.safeParse({ ...payload, [field]: resume[field] }).success).toBe(
          false,
        );
      }
    });

    it('bounds the session reference, the answer and the seq', () => {
      const valid = (patch: object) => runPayloadSchema.safeParse({ ...resume, ...patch }).success;
      expect(valid({ sessionRef: 's'.repeat(SESSION_REF_MAX_LENGTH) })).toBe(true);
      expect(valid({ sessionRef: 's'.repeat(SESSION_REF_MAX_LENGTH + 1) })).toBe(false);
      expect(valid({ sessionRef: '' })).toBe(false);
      expect(valid({ answer: 'a'.repeat(ANSWER_MAX_LENGTH) })).toBe(true);
      expect(valid({ answer: 'a'.repeat(ANSWER_MAX_LENGTH + 1) })).toBe(false);
      expect(valid({ answer: '' })).toBe(false);
      expect(valid({ nextSeq: 0 })).toBe(false);
      expect(valid({ nextSeq: 1 })).toBe(true);
    });
  });

  it("carries a delivery's recorded Run branch, and only with deliver (review R1 of #122)", () => {
    expect(runPayloadSchema.safeParse({ ...payload, runBranch: 'agent/x-r0b8e5c2d' }).success).toBe(
      false,
    );
    expect(runPayloadSchema.safeParse({ ...payload, kind: 'deliver', runBranch: '' }).success).toBe(
      false,
    );
  });

  it("carries Studio's list of the files it places in the Working copy (review R3 of #122)", () => {
    const withPaths = (studioPaths: unknown) =>
      runPayloadSchema.safeParse({ ...payload, studioPaths }).success;

    expect(withPaths(['.env.studio'])).toBe(true);
    expect(withPaths([''])).toBe(false);
    expect(withPaths(Array.from({ length: 51 }, (_, n) => `f${n}`))).toBe(false);
    expect(withPaths(undefined)).toBe(false);
  });

  it('names the integration branch the pull request targets (Issue #102)', () => {
    const withBranch = (integrationBranch: unknown) =>
      runPayloadSchema.safeParse({ ...payload, integrationBranch }).success;

    expect(withBranch('main')).toBe(true);
    expect(withBranch('')).toBe(false);
    expect(withBranch('b'.repeat(256))).toBe(false);
    expect(withBranch(undefined)).toBe(false);
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
    expect(report({ state: 'succeeded', delivery: { outcome: 'none' } })).toBe(true);
    expect(report({ state: 'failed', failure: { code: 'agent_failed', detail: 'exit 1' } })).toBe(
      true,
    );

    expect(report({ state: 'failed' })).toBe(false);
    expect(report({ state: 'succeeded', failure: { code: 'unknown', detail: '' } })).toBe(false);
    // Issue #102 (review of #122): a succeeded Run always says how it was delivered.
    expect(report({ state: 'succeeded' })).toBe(false);
    expect(report({ state: 'queued' })).toBe(false);
    expect(report({ state: 'preparing' })).toBe(false);
    expect(report({ state: 'cancelled', failure: { code: 'unknown', detail: '' } })).toBe(false);
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
    // Issue #100: a cancelled or timed-out Run keeps its Working copy, and its state is recorded.
    expect(report({ state: 'cancelled', workingCopy })).toBe(true);
    expect(report({ state: 'timed_out', workingCopy })).toBe(true);
    // A delivery retry reports the Working copy with its outcome (Issue #102).
    expect(report({ state: 'succeeded', delivery: { outcome: 'none' }, workingCopy })).toBe(true);
    expect(report({ state: 'running', workingCopy })).toBe(false);
    expect(
      report({ state: 'failed', failure, workingCopy: { ...workingCopy, commits: [{ id: 'x' }] } }),
    ).toBe(false);
  });

  it('reports a delivery outcome with succeeded only (Issue #102)', () => {
    const report = (body: object) =>
      reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, ...body }).success;
    const pullRequest = { url: 'https://github.com/acme/shop/pull/7', number: 7 };

    expect(report({ state: 'succeeded', delivery: { outcome: 'none' } })).toBe(true);
    expect(report({ state: 'succeeded', delivery: { outcome: 'delivered', pullRequest } })).toBe(
      true,
    );

    expect(report({ state: 'succeeded', delivery: { outcome: 'delivered' } })).toBe(false);
    expect(report({ state: 'succeeded', delivery: { outcome: 'none', pullRequest } })).toBe(false);
    expect(report({ state: 'running', delivery: { outcome: 'none' } })).toBe(false);
    expect(
      report({
        state: 'failed',
        failure: { code: 'delivery_failed', detail: 'push refused' },
        delivery: { outcome: 'none' },
      }),
    ).toBe(false);
    const delivered = (pr: object) =>
      report({ state: 'succeeded', delivery: { outcome: 'delivered', pullRequest: pr } });
    expect(delivered({ ...pullRequest, url: 'http://github.com/acme/shop/pull/7' })).toBe(false);
    expect(delivered({ ...pullRequest, url: 'javascript:alert(1)' })).toBe(false);
    expect(delivered({ ...pullRequest, number: 0 })).toBe(false);
    expect(delivered({ ...pullRequest, number: 1.5 })).toBe(false);
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
    const body = { workerId: WORKER_ID, index: 1, kind: 'start', result, workingCopy };
    expect(reportRunStepRequestSchema.parse(body)).toEqual(body);
    expect(reportRunStepRequestSchema.safeParse({ ...body, kind: 'retry' }).success).toBe(false);
    // Review of #121: every step report carries its number, 1, 2, …
    expect(reportRunStepRequestSchema.safeParse({ ...body, index: undefined }).success).toBe(false);
    expect(reportRunStepRequestSchema.safeParse({ ...body, index: 0 }).success).toBe(false);
    expect(reportRunStepRequestSchema.safeParse({ ...body, index: 1.5 }).success).toBe(false);
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

describe('cancellation and limits (Issue #100)', () => {
  const payload = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    provider: 'codex',
    task: 'Add a health check',
    startCommit: 'a'.repeat(40),
    repository: { remoteUrl: 'https://github.com/acme/shop.git' },
    integrationBranch: 'dev',
    kind: 'start',
    studioPaths: [],
    limits: { stepMinutes: 60, maxSteps: 10 },
    completedSteps: 0,
  };

  it('a worker reports a confirmed cancel or a timed-out Run step', () => {
    const report = (state: string) =>
      reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, state }).success;

    expect(report('cancelled')).toBe(true);
    expect(report('timed_out')).toBe(true);
  });

  it('the step limit is a failure code of its own', () => {
    expect(RUN_FAILURE_CODES).toContain('step_limit');
    expect(
      reportRunStateRequestSchema.safeParse({
        workerId: WORKER_ID,
        state: 'failed',
        failure: { code: 'step_limit', detail: 'The run reached its limit of 10 run steps.' },
      }).success,
    ).toBe(true);
  });

  it('the claim payload carries the limits in force and the Run steps already taken', () => {
    expect(runPayloadSchema.safeParse({ ...payload, limits: undefined }).success).toBe(false);
    expect(runPayloadSchema.safeParse({ ...payload, completedSteps: undefined }).success).toBe(
      false,
    );
    expect(runPayloadSchema.safeParse({ ...payload, completedSteps: -1 }).success).toBe(false);
    expect(runPayloadSchema.safeParse({ ...payload, completedSteps: 1.5 }).success).toBe(false);
  });

  it('limits are whole, positive numbers within bounds', () => {
    const limits = (value: object) => runLimitsSchema.safeParse(value).success;

    expect(limits({ stepMinutes: 1, maxSteps: 1 })).toBe(true);
    expect(limits({ stepMinutes: 1440, maxSteps: 100 })).toBe(true);
    expect(limits({ stepMinutes: 0, maxSteps: 10 })).toBe(false);
    expect(limits({ stepMinutes: 60, maxSteps: 0 })).toBe(false);
    expect(limits({ stepMinutes: 1441, maxSteps: 10 })).toBe(false);
    expect(limits({ stepMinutes: 60, maxSteps: 101 })).toBe(false);
    expect(limits({ stepMinutes: 60.5, maxSteps: 10 })).toBe(false);
    expect(limits({ stepMinutes: 60, maxSteps: 10, waitingDays: 14 })).toBe(false);
  });

  it('the heartbeat answer says whether the operator asked to cancel', () => {
    expect(heartbeatResponseSchema.parse({ cancelRequested: true })).toEqual({
      cancelRequested: true,
    });
    expect(heartbeatResponseSchema.safeParse({}).success).toBe(false);
    expect(heartbeatResponseSchema.safeParse({ cancelRequested: 'yes' }).success).toBe(false);
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

  it('needs a question and a session reference when the agent needs input (Issue #103)', () => {
    const question = { text: 'Which database?' };
    const valid = (result: object) => runStepResultSchema.safeParse(result).success;
    expect(valid({ outcome: 'needs_input', summary: 'Stuck.', sessionRef: 's-1' })).toBe(false);
    expect(valid({ outcome: 'needs_input', summary: 'Stuck.', question })).toBe(false);
    expect(valid({ outcome: 'needs_input', summary: 'Stuck.', question, sessionRef: 's-1' })).toBe(
      true,
    );
    // A done result may carry its session too (a later follow-up); it never needs one.
    expect(valid({ outcome: 'done', summary: 'Done.', sessionRef: 's-1' })).toBe(true);
  });

  it('a question has its text, at most six options and a recommendation (Issue #103)', () => {
    const valid = (question: unknown) =>
      runStepResultSchema.safeParse({
        outcome: 'needs_input',
        summary: 'Stuck.',
        question,
        sessionRef: 's-1',
      }).success;
    const full = {
      text: 'Which database?',
      options: ['PostgreSQL', 'SQLite'],
      recommendation: 'PostgreSQL',
    };
    expect(valid(full)).toBe(true);
    expect(valid('Which database?')).toBe(false);
    expect(valid({ text: '' })).toBe(false);
    expect(valid({ text: 'q'.repeat(QUESTION_TEXT_MAX_LENGTH) })).toBe(true);
    expect(valid({ text: 'q'.repeat(QUESTION_TEXT_MAX_LENGTH + 1) })).toBe(false);
    expect(valid({ ...full, options: Array.from({ length: 6 }, (_, n) => `o${n}`) })).toBe(true);
    expect(valid({ ...full, options: Array.from({ length: 7 }, (_, n) => `o${n}`) })).toBe(false);
    expect(valid({ ...full, options: ['o'.repeat(QUESTION_OPTION_MAX_LENGTH + 1)] })).toBe(false);
    expect(valid({ ...full, options: [''] })).toBe(false);
    expect(valid({ ...full, recommendation: 'r'.repeat(QUESTION_OPTION_MAX_LENGTH + 1) })).toBe(
      false,
    );
    expect(valid({ ...full, extra: true })).toBe(false);
  });

  it('bounds the session reference at 256 characters (Issue #103)', () => {
    const valid = (sessionRef: string) =>
      runStepResultSchema.safeParse({ outcome: 'done', summary: '', sessionRef }).success;
    expect(valid('s'.repeat(SESSION_REF_MAX_LENGTH))).toBe(true);
    expect(valid('s'.repeat(SESSION_REF_MAX_LENGTH + 1))).toBe(false);
    expect(valid('')).toBe(false);
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
    ['a sequence number above PostgreSQL INTEGER', [event(2_147_483_648)]],
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
      index: 2_147_483_647,
      kind: 'resume',
      result: resultOf(RUN_STEP_RESULT_MAX_BYTES),
      workingCopy,
    };
    expect(reportRunStepRequestSchema.safeParse(body).success).toBe(true);
    expect(jsonByteLength(body)).toBeLessThan(WORKER_REQUEST_MAX_BYTES);
    expect(WORKER_REQUEST_MAX_BYTES).toBe(192 * 1024);
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
