import { describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTIONS_MAX_BYTES,
  ANSWER_MAX_LENGTH,
  appendRunEventsRequestSchema,
  claimLookupsResponseSchema,
  LOOKUP_CLAIM_MAX,
  lookupPayloadSchema,
  lookupResultRequestSchema,
  pullRequestStateResultSchema,
  failingCheckLogsResultSchema,
  reviewCommentsResultSchema,
  REVIEW_COMMENTS_MAX,
  REVIEW_COMMENT_TEXT_MAX_BYTES,
  FAILING_CHECK_EXCERPT_MAX_LENGTH,
  FAILING_CHECK_EXCERPTS_TOTAL_MAX_LENGTH,
  PULL_REQUEST_CHECKS_MAX,
  FOLLOW_UP_MAX_LENGTH,
  RESUME_REASONS,
  runDeliverySchema,
  QUESTION_OPTION_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  SESSION_REF_MAX_LENGTH,
  claimRunRequestSchema,
  cutToBytes,
  ENVIRONMENT_FILE_MAX_BYTES,
  ENVIRONMENT_FILE_PATH_MAX_LENGTH,
  environmentFilePathProblem,
  jsonByteLength,
  RUN_STEP_RESULT_MAX_BYTES,
  RUN_DIFF_FILE_PATCH_MAX_BYTES,
  RUN_DIFF_FILE_STATUSES,
  RUN_DIFF_FILES_MAX,
  RUN_DIFF_MAX_BYTES,
  RUN_DIFF_PATCH_MAX_BYTES,
  RUN_DIFF_REQUEST_MAX_BYTES,
  RUN_DIFF_UNAVAILABLE_MAX_LENGTH,
  reportRunDiffRequestSchema,
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

const WORKER_ID = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const PROJECT_ID = '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b';

/** The base rules and the built-in Default agent every claim of a Claude Code Run carries. */
const AGENT_FIELDS = {
  baseRules: { version: '2026-11-19.1', text: 'Base rules text.' },
  agent: {
    name: 'default-claude-code',
    source: 'built_in',
    commit: null,
    provider: 'claude_code',
    model: 'default',
    instructions: '',
  },
  skills: [],
};

describe('run payload (claim response)', () => {
  const payload = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    provider: 'claude_code',
    ...AGENT_FIELDS,
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

  describe('the base rules and the recorded agent', () => {
    const definitions = {
      name: 'reviewer',
      source: 'definitions',
      commit: 'b'.repeat(40),
      provider: 'claude_code',
      model: 'opus',
      instructions: 'Review carefully.',
    };
    const valid = (patch: object) => runPayloadSchema.safeParse({ ...payload, ...patch }).success;

    it('carries a definitions agent with its commit', () => {
      expect(valid({ agent: definitions })).toBe(true);
    });

    it('requires all three, the skills included (empty for none), since the worker and Studio deploy together', () => {
      const { baseRules: _rules, ...withoutRules } = payload;
      const { agent: _agent, ...withoutAgent } = payload;
      const { skills: _skills, ...withoutSkills } = payload;
      void _rules;
      void _agent;
      void _skills;

      expect(runPayloadSchema.safeParse(withoutRules).success).toBe(false);
      expect(runPayloadSchema.safeParse(withoutAgent).success).toBe(false);
      expect(runPayloadSchema.safeParse(withoutSkills).success).toBe(false);
      expect(valid({ skills: [{ name: 'lint', description: 'Lints.' }] })).toBe(true);
    });

    it('ties the commit to the source', () => {
      expect(valid({ agent: { ...definitions, commit: null } })).toBe(false);
      expect(valid({ agent: { ...payload.agent, commit: 'b'.repeat(40) } })).toBe(false);
      expect(valid({ agent: { ...definitions, commit: 'main' } })).toBe(false);
    });

    it('keeps the Provider of the Run the Provider of its agent', () => {
      expect(valid({ provider: 'codex' })).toBe(false);
      expect(valid({ provider: 'codex', agent: { ...definitions, provider: 'codex' } })).toBe(true);
    });

    it('bounds the instructions in UTF-8 bytes, not characters', () => {
      const fits = 'é'.repeat(AGENT_INSTRUCTIONS_MAX_BYTES / 2);
      const over = 'é'.repeat(AGENT_INSTRUCTIONS_MAX_BYTES / 2 + 1);

      expect(valid({ agent: { ...definitions, instructions: fits } })).toBe(true);
      expect(valid({ agent: { ...definitions, instructions: over } })).toBe(false);
    });

    it('bounds the instructions and refuses unknown fields', () => {
      expect(
        valid({
          agent: { ...definitions, instructions: 'x'.repeat(AGENT_INSTRUCTIONS_MAX_BYTES) },
        }),
      ).toBe(true);
      expect(
        valid({
          agent: { ...definitions, instructions: 'x'.repeat(AGENT_INSTRUCTIONS_MAX_BYTES + 1) },
        }),
      ).toBe(false);
      expect(valid({ agent: { ...definitions, tools: ['bash'] } })).toBe(false);
      expect(valid({ baseRules: { ...payload.baseRules, extra: 1 } })).toBe(false);
      expect(valid({ baseRules: { ...payload.baseRules, text: '' } })).toBe(false);
    });
  });

  it('hands out a Run to start or, after a retry request, only to deliver', () => {
    const withKind = (kind: unknown) => runPayloadSchema.safeParse({ ...payload, kind }).success;

    expect(withKind('start')).toBe(true);
    expect(withKind('deliver')).toBe(false);
    expect(
      runPayloadSchema.safeParse({
        ...payload,
        kind: 'deliver',
        runBranch: 'agent/x-r0b8e5c2d',
        nextSeq: 1,
      }).success,
    ).toBe(true);
    expect(withKind('resume')).toBe(false);
    expect(withKind(undefined)).toBe(false);
  });

  it('hands back the diff state with a resume or delivery claim, never with a start', () => {
    const diffState = {
      resultTree: 'b'.repeat(40),
      resultCommit: 'c'.repeat(40),
      previousTree: 'd'.repeat(40),
      previousCommit: 'a'.repeat(40),
    };
    const deliver = { ...payload, kind: 'deliver', runBranch: 'agent/x-r0b8e5c2d', nextSeq: 1 };
    expect(runPayloadSchema.safeParse({ ...deliver, diffState }).success).toBe(true);
    expect(runPayloadSchema.safeParse({ ...payload, diffState }).success).toBe(false);
    expect(
      runPayloadSchema.safeParse({ ...deliver, diffState: { ...diffState, resultTree: 'x' } })
        .success,
    ).toBe(false);
  });

  describe('a resume claim', () => {
    const resume = {
      ...payload,
      kind: 'resume',
      runBranch: 'agent/x-r0b8e5c2d',
      sessionRef: 'session-1',
      answer: 'Use PostgreSQL.',
      resumeReason: 'answer',
      nextSeq: 42,
      completedSteps: 1,
    };

    it("carries the session reference, the operator's answer, the next seq and the Run branch", () => {
      expect(runPayloadSchema.parse(resume)).toEqual(resume);
    });

    it('needs all five, and only a resume claim carries the session and answer', () => {
      for (const field of [
        'runBranch',
        'sessionRef',
        'answer',
        'resumeReason',
        'nextSeq',
      ] as const) {
        const { [field]: _left, ...without } = resume;
        void _left;
        expect(runPayloadSchema.safeParse(without).success).toBe(false);
      }
      for (const field of ['sessionRef', 'answer', 'resumeReason', 'nextSeq'] as const) {
        expect(runPayloadSchema.safeParse({ ...payload, [field]: resume[field] }).success).toBe(
          false,
        );
      }
    });

    it('a delivery claim carries the next seq too, never a session or an answer', () => {
      const deliver = { ...payload, kind: 'deliver', runBranch: 'agent/x-r0b8e5c2d', nextSeq: 9 };
      expect(runPayloadSchema.safeParse(deliver).success).toBe(true);
      const { nextSeq: _seq, ...withoutSeq } = deliver;
      void _seq;
      expect(runPayloadSchema.safeParse(withoutSeq).success).toBe(false);
      expect(runPayloadSchema.safeParse({ ...deliver, answer: 'x' }).success).toBe(false);
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

  describe('a Follow-up claim', () => {
    const followUp = {
      ...payload,
      kind: 'resume',
      runBranch: 'agent/x-r0b8e5c2d',
      sessionRef: 'session-1',
      answer: 'Also handle the empty list.',
      resumeReason: 'follow_up',
      followUpNumber: 1,
      stepsBeforePart: 3,
      pullRequestNumber: 7,
      nextSeq: 120,
      completedSteps: 3,
    };

    it('carries the Follow-up text, its number, the steps before it and the recorded pull request', () => {
      expect(runPayloadSchema.parse(followUp)).toEqual(followUp);
      for (const reason of RESUME_REASONS.filter((name) => name !== 'bring_up_to_date')) {
        expect(runPayloadSchema.safeParse({ ...followUp, resumeReason: reason }).success).toBe(
          true,
        );
      }
      expect(runPayloadSchema.safeParse({ ...followUp, resumeReason: 'other' }).success).toBe(
        false,
      );
    });

    it('needs the Follow-up number with the reason follow_up, and only with a resume claim', () => {
      const { followUpNumber: _number, ...withoutNumber } = followUp;
      void _number;
      expect(runPayloadSchema.safeParse(withoutNumber).success).toBe(false);
      expect(runPayloadSchema.safeParse({ ...withoutNumber, resumeReason: 'answer' }).success).toBe(
        true,
      );
      expect(runPayloadSchema.safeParse({ ...payload, followUpNumber: 1 }).success).toBe(false);
      expect(runPayloadSchema.safeParse({ ...followUp, followUpNumber: 0 }).success).toBe(false);
    });

    it('bounds the Follow-up text by its own limit and an answer by the answer limit', () => {
      const valid = (patch: object) =>
        runPayloadSchema.safeParse({ ...followUp, ...patch }).success;
      expect(valid({ answer: 'a'.repeat(FOLLOW_UP_MAX_LENGTH) })).toBe(true);
      expect(valid({ answer: 'a'.repeat(FOLLOW_UP_MAX_LENGTH + 1) })).toBe(false);
      const { followUpNumber: _number, ...answer } = followUp;
      void _number;
      expect(
        runPayloadSchema.safeParse({
          ...answer,
          resumeReason: 'answer',
          answer: 'a'.repeat(ANSWER_MAX_LENGTH + 1),
        }).success,
      ).toBe(false);
    });

    it('carries the recorded pull request with a resume or delivery claim, never a start', () => {
      expect(runPayloadSchema.safeParse({ ...payload, pullRequestNumber: 7 }).success).toBe(false);
      expect(
        runPayloadSchema.safeParse({
          ...payload,
          kind: 'deliver',
          runBranch: 'agent/x-r0b8e5c2d',
          nextSeq: 3,
          pullRequestNumber: 7,
        }).success,
      ).toBe(true);
      expect(runPayloadSchema.safeParse({ ...followUp, pullRequestNumber: 0 }).success).toBe(false);
      expect(runPayloadSchema.safeParse({ ...followUp, stepsBeforePart: -1 }).success).toBe(false);
    });
  });

  it("carries a delivery's recorded Run branch, and only with deliver", () => {
    expect(runPayloadSchema.safeParse({ ...payload, runBranch: 'agent/x-r0b8e5c2d' }).success).toBe(
      false,
    );
    expect(runPayloadSchema.safeParse({ ...payload, kind: 'deliver', runBranch: '' }).success).toBe(
      false,
    );
  });

  it("carries Studio's list of the files it places in the Working copy", () => {
    const withPaths = (studioPaths: unknown) =>
      runPayloadSchema.safeParse({ ...payload, studioPaths }).success;

    expect(withPaths(['.env.studio'])).toBe(true);
    expect(withPaths([''])).toBe(false);
    expect(withPaths(Array.from({ length: 51 }, (_, n) => `f${n}`))).toBe(false);
    expect(withPaths(undefined)).toBe(false);
  });

  it('names the integration branch the pull request targets', () => {
    const withBranch = (integrationBranch: unknown) =>
      runPayloadSchema.safeParse({ ...payload, integrationBranch }).success;

    expect(withBranch('main')).toBe(true);
    expect(withBranch('')).toBe(false);
    expect(withBranch('b'.repeat(256))).toBe(false);
    expect(withBranch(undefined)).toBe(false);
  });

  it("carries the Repository's remote URL and nothing else about it", () => {
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
    const codex = {
      provider: 'codex',
      agent: { ...payload.agent, name: 'default-codex', provider: 'codex' },
    };
    expect(runPayloadSchema.safeParse({ ...payload, ...codex }).success).toBe(true);
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

describe('Environment file', () => {
  const payload = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    provider: 'claude_code',
    ...AGENT_FIELDS,
    task: 'Add a health check',
    startCommit: 'a'.repeat(40),
    repository: { remoteUrl: 'git@github.com:acme/shop.git' },
    integrationBranch: 'main',
    kind: 'start',
    studioPaths: ['.env'],
    limits: { stepMinutes: 60, maxSteps: 10 },
    completedSteps: 0,
  };
  const environmentFile = { path: '.env', content: 'DB_PASSWORD=test-only-1234\n' };

  it('travels with the claim of a Run that has one, path and content only', () => {
    expect(runPayloadSchema.parse({ ...payload, environmentFile })).toEqual({
      ...payload,
      environmentFile,
    });
    expect(
      runPayloadSchema.safeParse({ ...payload, environmentFile: { ...environmentFile, id: 'x' } })
        .success,
    ).toBe(false);
  });

  it('comes with a start claim only, its path among the studioPaths', () => {
    expect(
      runPayloadSchema.safeParse({ ...payload, studioPaths: [], environmentFile }).success,
    ).toBe(false);
    expect(
      runPayloadSchema.safeParse({
        ...payload,
        kind: 'deliver',
        runBranch: 'agent/x-r0b8e5c2d',
        nextSeq: 1,
        environmentFile,
      }).success,
    ).toBe(false);
  });

  it('limits the content to 64 KiB of UTF-8', () => {
    expect(ENVIRONMENT_FILE_MAX_BYTES).toBe(65_536);
    const withContent = (content: string) =>
      runPayloadSchema.safeParse({ ...payload, environmentFile: { path: '.env', content } })
        .success;
    expect(withContent('x'.repeat(65_536))).toBe(true);
    expect(withContent('x'.repeat(65_537))).toBe(false);
    // Two bytes each in UTF-8: under the limit in characters, over it in bytes.
    expect(withContent('é'.repeat(32_769))).toBe(false);
  });

  it('refuses a path that is not a safe relative path in the Working copy', () => {
    expect(
      runPayloadSchema.safeParse({ ...payload, environmentFile: { path: '../.env', content: '' } })
        .success,
    ).toBe(false);
  });

  it.each(['.env', 'config/test.env', 'apps/api/.env.test', '.git-env', 'a/.gitx/b', 'x'])(
    'accepts the path %s',
    (path) => {
      expect(environmentFilePathProblem(path)).toBeNull();
    },
  );

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['\\\\server\\share', 'backslash'],
    ['a\\b', 'backslash'],
    ['../.env', 'traversal'],
    ['config/../../.env', 'traversal'],
    ['./.env', 'dot segment'],
    ['config//.env', 'empty segment'],
    ['config/', 'empty segment'],
    ['.git', 'inside .git'],
    ['.git/config', 'inside .git'],
    ['.GIT/hooks/pre-commit', 'inside .git'],
    ['sub/.git/config', 'inside .git'],
    ['a\u0000b', 'control character'],
    ['a\nb', 'control character'],
    ['a\u007fb', 'control character'],
    ['x'.repeat(ENVIRONMENT_FILE_PATH_MAX_LENGTH + 1), 'too long'],
  ])('refuses the path %j (%s), saying why', (path) => {
    const problem = environmentFilePathProblem(path);
    expect(problem).toEqual(expect.any(String));
    expect(problem!.length).toBeGreaterThan(10);
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
    expect(report({ state: 'succeeded' })).toBe(false);
    expect(report({ state: 'queued' })).toBe(false);
    expect(report({ state: 'preparing' })).toBe(false);
    expect(report({ state: 'cancelled', failure: { code: 'unknown', detail: '' } })).toBe(false);
    expect(report({ state: 'failed', failure: { code: 'oops', detail: '' } })).toBe(false);
  });

  it("carries a failed Run's Working copy state, and only with the state failed", () => {
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
    expect(report({ state: 'cancelled', workingCopy })).toBe(true);
    expect(report({ state: 'timed_out', workingCopy })).toBe(true);
    expect(report({ state: 'succeeded', delivery: { outcome: 'none' }, workingCopy })).toBe(true);
    expect(report({ state: 'running', workingCopy })).toBe(false);
    expect(
      report({ state: 'failed', failure, workingCopy: { ...workingCopy, commits: [{ id: 'x' }] } }),
    ).toBe(false);
  });

  it('reports a delivery outcome with succeeded only', () => {
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
    for (const url of [
      'https://github.example.com/acme/shop/pull/7',
      'https://github.com.evil.test/acme/shop/pull/7',
      'https://evil.test/acme/shop/pull/7',
      'https://user@github.com/acme/shop/pull/7',
      'https://github.com:8443/acme/shop/pull/7',
      'https://github.com/acme/shop/issues/7',
      'https://github.com/acme/shop/pull/7/files',
      'https://github.com/acme/shop/pull/7?x=1',
    ]) {
      expect(delivered({ ...pullRequest, url }), url).toBe(false);
    }
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
    expect(reportRunStepRequestSchema.safeParse({ ...body, index: undefined }).success).toBe(false);
    expect(reportRunStepRequestSchema.safeParse({ ...body, index: 0 }).success).toBe(false);
    expect(reportRunStepRequestSchema.safeParse({ ...body, index: 1.5 }).success).toBe(false);
  });

  it("carries the Working copy's state with every Run step report", () => {
    const result = { outcome: 'done', summary: 'Done.' };
    expect(
      reportRunStepRequestSchema.safeParse({ workerId: WORKER_ID, kind: 'start', result }).success,
    ).toBe(false);
  });

  it('asks for the states of 1-500 Run ids', () => {
    const ask = (runIds: unknown) =>
      runStatesRequestSchema.safeParse({ workerId: WORKER_ID, runIds }).success;

    expect(ask([RUN_ID])).toBe(true);
    expect(ask(Array.from({ length: 500 }, () => RUN_ID))).toBe(true);
    expect(ask([])).toBe(false);
    expect(ask(Array.from({ length: 501 }, () => RUN_ID))).toBe(false);
    expect(ask(['../../etc'])).toBe(false);
  });

  it('may report the Runs whose Working copies retention removed', () => {
    const ask = (removedRunIds: unknown) =>
      runStatesRequestSchema.safeParse({ workerId: WORKER_ID, runIds: [RUN_ID], removedRunIds })
        .success;
    expect(ask(undefined)).toBe(true);
    expect(ask([])).toBe(true);
    expect(ask([RUN_ID])).toBe(true);
    expect(ask(['not-a-run'])).toBe(false);
    expect(ask(Array.from({ length: 501 }, () => RUN_ID))).toBe(false);
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

  it('says how long a final Run is kept, or that it is removable', () => {
    const finishedAt = '2026-11-15T10:00:00.000Z';
    const keep = {
      runId: RUN_ID,
      state: 'succeeded',
      finishedAt,
      keepUntil: '2026-11-22T10:00:00.000Z',
    };
    const remove = { runId: RUN_ID, state: 'failed', finishedAt, removable: true };
    expect(runStatesResponseSchema.parse([keep, remove])).toEqual([keep, remove]);
    const session = { provider: 'codex', ref: 'a1b2c3d4-0000-4000-8000-000000000001' };
    expect(runStatesResponseSchema.safeParse([{ ...remove, session }]).success).toBe(true);
    for (const bad of [
      { ...keep, removable: true },
      { ...keep, keepUntil: 'tomorrow' },
      { ...remove, removable: false },
      { ...keep, session },
      { ...remove, session: { provider: 'gpt', ref: 'x' } },
    ]) {
      expect(runStatesResponseSchema.safeParse([bad]).success).toBe(false);
    }
  });
});

describe('cancellation and limits', () => {
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

describe('Working copy report', () => {
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

  it('needs a question and a session reference when the agent needs input', () => {
    const question = { text: 'Which database?' };
    const valid = (result: object) => runStepResultSchema.safeParse(result).success;
    expect(valid({ outcome: 'needs_input', summary: 'Stuck.', sessionRef: 's-1' })).toBe(false);
    expect(valid({ outcome: 'needs_input', summary: 'Stuck.', question })).toBe(false);
    expect(valid({ outcome: 'needs_input', summary: 'Stuck.', question, sessionRef: 's-1' })).toBe(
      true,
    );
    expect(valid({ outcome: 'done', summary: 'Done.', sessionRef: 's-1' })).toBe(true);
  });

  it('a question has its text, at most six options and a recommendation', () => {
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

  it('bounds the session reference at 256 characters', () => {
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
  it('is an agent message, a command, output or a notice', () => {
    expect(runnerEventSchema.parse({ type: 'output', text: 'compiling' })).toEqual({
      type: 'output',
      text: 'compiling',
    });
    for (const type of ['message', 'command', 'output', 'notice']) {
      expect(runnerEventSchema.safeParse({ type, text: 'x' }).success).toBe(true);
    }
    expect(runnerEventSchema.safeParse({ type: 'status', text: '' }).success).toBe(false);
    expect(runnerEventSchema.safeParse({ type: 'step_started', text: '' }).success).toBe(false);
  });
});

describe('appending Run events', () => {
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

describe('size of a structured result', () => {
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

  it('leaves room for a maximal step report under the request body limit', () => {
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

describe('worker status report', () => {
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
    ['a reason for an unknown provider', { ...report, providerReasons: { gpt: 'x' } }],
    ['an empty reason', { ...report, providerReasons: { claude_code: '' } }],
    ['a reason that is too long', { ...report, providerReasons: { codex: 'x'.repeat(501) } }],
  ])('refuses %s', (_case, body) => {
    expect(workerStatusRequestSchema.safeParse(body).success).toBe(false);
  });

  it('may carry the disk figures of the agent side', () => {
    const disk = {
      workingCopiesBytes: 5_000_000,
      cachesBytes: 1_000_000,
      keptRuns: 3,
      freeBytes: 80_000_000_000,
      totalBytes: 200_000_000_000,
      minFreeBytes: 10_737_418_240,
    };
    expect(workerStatusRequestSchema.parse({ ...report, disk })).toEqual({ ...report, disk });
    expect(workerStatusRequestSchema.safeParse(report).success).toBe(true);
    for (const bad of [
      { ...disk, keptRuns: -1 },
      { ...disk, freeBytes: 1.5 },
      { ...disk, cachesBytes: undefined },
      { ...disk, extra: 1 },
    ]) {
      expect(workerStatusRequestSchema.safeParse({ ...report, disk: bad }).success).toBe(false);
    }
  });

  it('carries why a switched-on provider is unavailable on the worker', () => {
    const withReason = {
      ...report,
      providerReasons: { claude_code: 'Claude Code 2.2.0 is not supported (>=2.1.325 <2.2.0).' },
    };
    expect(workerStatusRequestSchema.parse(withReason)).toEqual(withReason);
    expect(workerStatusRequestSchema.safeParse({ ...report, providerReasons: {} }).success).toBe(
      true,
    );
  });
});

describe('a Run that reached the usage limit', () => {
  const report = (body: object) =>
    reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, ...body }).success;
  const usageLimit = { code: 'usage_limit', detail: 'The usage limit was reached.' };

  it('may carry the agent session to resume later, with the failure usage_limit only', () => {
    expect(report({ state: 'failed', failure: usageLimit, sessionRef: 'session-1' })).toBe(true);
    expect(report({ state: 'failed', failure: usageLimit })).toBe(true);
    expect(
      report({
        state: 'failed',
        failure: { code: 'agent_failed', detail: 'x' },
        sessionRef: 'session-1',
      }),
    ).toBe(false);
    expect(report({ state: 'running', sessionRef: 'session-1' })).toBe(false);
    expect(report({ state: 'failed', failure: usageLimit, sessionRef: '' })).toBe(false);
    expect(
      report({
        state: 'failed',
        failure: usageLimit,
        sessionRef: 's'.repeat(SESSION_REF_MAX_LENGTH + 1),
      }),
    ).toBe(false);
  });
});

describe('a cancel during the delivery', () => {
  it('a cancelled report may carry what the delivery did; succeeded must, others must not', () => {
    const report = (body: object) =>
      reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, ...body }).success;
    const delivery = { outcome: 'none' };

    expect(report({ state: 'cancelled', delivery })).toBe(true);
    expect(report({ state: 'cancelled' })).toBe(true);
    expect(report({ state: 'succeeded' })).toBe(false);
    expect(report({ state: 'timed_out', delivery })).toBe(false);
    expect(report({ state: 'waiting_for_operator', delivery })).toBe(false);
  });
});

describe('a pushed branch without a pull request', () => {
  it('is reported only with cancelled', () => {
    const report = (state: string) =>
      reportRunStateRequestSchema.safeParse({
        workerId: WORKER_ID,
        state,
        delivery: { outcome: 'none', branchPushed: true },
      }).success;

    expect(report('cancelled')).toBe(true);
    expect(report('succeeded')).toBe(false);
  });
});

describe('the pushed commit of a delivery', () => {
  const pullRequest = { url: 'https://github.com/acme/shop/pull/7', number: 7 };

  it('comes with a delivered pull request or a pushed branch, as a commit id', () => {
    const valid = (delivery: object) => runDeliverySchema.safeParse(delivery).success;
    expect(valid({ outcome: 'delivered', pullRequest, pushedCommit: 'a'.repeat(40) })).toBe(true);
    expect(valid({ outcome: 'delivered', pullRequest, pushedCommit: 'b'.repeat(64) })).toBe(true);
    expect(valid({ outcome: 'delivered', pullRequest })).toBe(true);
    expect(valid({ outcome: 'delivered', pullRequest, pushedCommit: 'main' })).toBe(false);
    expect(valid({ outcome: 'none', branchPushed: true, pushedCommit: 'c'.repeat(40) })).toBe(true);
    expect(valid({ outcome: 'none', pushedCommit: 'c'.repeat(40) })).toBe(false);
  });
});

describe('a Follow-up with a new Environment file snapshot', () => {
  const resume = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    provider: 'claude_code',
    ...AGENT_FIELDS,
    task: 'Add a health check',
    startCommit: 'a'.repeat(40),
    repository: { remoteUrl: 'git@github.com:acme/shop.git' },
    integrationBranch: 'dev',
    kind: 'resume',
    runBranch: 'agent/x-r0b8e5c2d',
    sessionRef: 'session-1',
    answer: 'Go on.',
    resumeReason: 'follow_up',
    followUpNumber: 1,
    nextSeq: 9,
    studioPaths: ['.env', 'config/.env'],
    limits: { stepMinutes: 60, maxSteps: 10 },
    completedSteps: 1,
  };
  const file = { path: 'config/.env', content: 'A=1\n' };
  const valid = (patch: object) => runPayloadSchema.safeParse({ ...resume, ...patch }).success;

  it('carries the replacement, with or without a file, only with a resume claim', () => {
    expect(valid({ replaceEnvironmentFile: true, environmentFile: file })).toBe(true);
    expect(valid({ replaceEnvironmentFile: true })).toBe(true);
    expect(valid({ environmentFile: file })).toBe(false);
    expect(valid({ replaceEnvironmentFile: true, environmentFile: { ...file, path: 'x' } })).toBe(
      false,
    );
    expect(
      runPayloadSchema.safeParse({
        ...resume,
        kind: 'deliver',
        sessionRef: undefined,
        answer: undefined,
        resumeReason: undefined,
        followUpNumber: undefined,
        replaceEnvironmentFile: true,
      }).success,
    ).toBe(false);
  });
});

describe('the pushed commit of a failed delivery', () => {
  const report = (body: object) =>
    reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, ...body }).success;
  it('comes only with delivery_failed', () => {
    const pushedCommit = 'a'.repeat(40);
    expect(
      report({
        state: 'failed',
        failure: { code: 'delivery_failed', detail: 'x' },
        pushedCommit,
      }),
    ).toBe(true);
    expect(
      report({ state: 'failed', failure: { code: 'agent_failed', detail: 'x' }, pushedCommit }),
    ).toBe(false);
    expect(report({ state: 'cancelled', pushedCommit })).toBe(false);
  });
});

describe('a Run diff report', () => {
  const file = {
    path: 'src/app.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n',
  };
  const diff = {
    baseCommit: 'a'.repeat(40),
    includesUnpushed: true,
    truncated: false,
    files: [file],
  };
  const state = {
    resultTree: 'b'.repeat(40),
    resultCommit: 'c'.repeat(40),
    previousTree: 'd'.repeat(40),
    previousCommit: 'a'.repeat(40),
  };
  const parse = (body: object) =>
    reportRunDiffRequestSchema.safeParse({
      workerId: WORKER_ID,
      ...('unavailable' in body ? {} : { state }),
      ...body,
    }).success;

  it('carries both diffs, the whole Run and since the previous result', () => {
    expect(parse({ run: diff, last: diff })).toBe(true);
    expect(parse({ run: diff })).toBe(false);
    expect(parse({ last: diff })).toBe(false);
  });

  it('carries where the diffs stand: full object ids only', () => {
    expect(
      parse({ run: diff, last: diff, state: { ...state, pushedCommit: 'e'.repeat(64) } }),
    ).toBe(true);
    expect(parse({ run: diff, last: diff, state: undefined })).toBe(false);
    expect(parse({ run: diff, last: diff, state: { ...state, resultTree: 'HEAD' } })).toBe(false);
    expect(parse({ run: diff, last: diff, state: { ...state, pushedCommit: 'abc' } })).toBe(false);
    expect(parse({ unavailable: 'failed', state })).toBe(false);
  });

  it('or the reason the diff could not be computed, never both', () => {
    expect(parse({ unavailable: 'git write-tree failed' })).toBe(true);
    expect(parse({ unavailable: '' })).toBe(false);
    expect(parse({ unavailable: 'x'.repeat(RUN_DIFF_UNAVAILABLE_MAX_LENGTH + 1) })).toBe(false);
    expect(parse({ run: diff, last: diff, unavailable: 'both' })).toBe(false);
    expect(parse({})).toBe(false);
  });

  it('lists each file with its status and counts; a rename names its previous path', () => {
    const files = (entry: object) => parse({ run: { ...diff, files: [entry] }, last: diff });
    for (const status of RUN_DIFF_FILE_STATUSES.filter((s) => s !== 'renamed')) {
      expect(files({ ...file, status })).toBe(true);
    }
    expect(files({ ...file, status: 'renamed', previousPath: 'src/old.ts' })).toBe(true);
    expect(files({ ...file, status: 'renamed' })).toBe(false);
    expect(files({ ...file, previousPath: 'src/old.ts' })).toBe(false);
    expect(files({ ...file, status: 'copied' })).toBe(false);
    expect(files({ ...file, additions: -1 })).toBe(false);
  });

  it('carries no content for a binary file or one over the per-file limit', () => {
    const files = (entry: object) => parse({ run: { ...diff, files: [entry] }, last: diff });
    const { patch, ...counted } = file;
    void patch;
    expect(files({ ...counted, binary: true })).toBe(true);
    expect(files({ ...counted, tooLarge: true })).toBe(true);
    expect(files({ ...file, binary: true })).toBe(false);
    expect(files({ ...file, tooLarge: true })).toBe(false);
    expect(files({ ...file, patch: 'x'.repeat(RUN_DIFF_FILE_PATCH_MAX_BYTES + 1) })).toBe(false);
  });

  it('keeps every limit: at most the listed files, unique paths, the total patch size', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...file, path: `f${i}`, patch: undefined }));
    expect(parse({ run: { ...diff, files: many(RUN_DIFF_FILES_MAX) }, last: diff })).toBe(true);
    expect(parse({ run: { ...diff, files: many(RUN_DIFF_FILES_MAX + 1) }, last: diff })).toBe(
      false,
    );
    expect(parse({ run: { ...diff, files: [file, file] }, last: diff })).toBe(false);
    const big = 'x'.repeat(RUN_DIFF_FILE_PATCH_MAX_BYTES - 10);
    const overTotal = Array.from(
      { length: Math.ceil(RUN_DIFF_PATCH_MAX_BYTES / RUN_DIFF_FILE_PATCH_MAX_BYTES) + 1 },
      (_, i) => ({ ...file, path: `f${i}`, patch: big }),
    );
    expect(parse({ run: { ...diff, files: overTotal }, last: diff })).toBe(false);
  });

  it('starts from a full commit id', () => {
    expect(parse({ run: { ...diff, baseCommit: 'abc' }, last: diff })).toBe(false);
  });

  it('fits its route body limit, which is larger than every other worker route', () => {
    expect(RUN_DIFF_REQUEST_MAX_BYTES).toBeGreaterThan(2 * RUN_DIFF_MAX_BYTES);
    expect(RUN_DIFF_REQUEST_MAX_BYTES).toBeGreaterThan(WORKER_REQUEST_MAX_BYTES);
  });
});

describe('lookups', () => {
  const LOOKUP_ID = 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f';
  const lookup = {
    id: LOOKUP_ID,
    kind: 'pull_request_state',
    runId: RUN_ID,
    repository: { remoteUrl: 'https://github.com/acme/shop.git' },
    pullRequestNumber: 7,
    runBranch: 'agent/add-store-r0b8e5c2d',
    integrationBranch: 'dev',
  };

  it('a claimed lookup carries what the worker needs, closed', () => {
    expect(lookupPayloadSchema.safeParse(lookup).success).toBe(true);
    expect(lookupPayloadSchema.safeParse({ ...lookup, extra: 1 }).success).toBe(false);
    expect(lookupPayloadSchema.safeParse({ ...lookup, kind: 'checks' }).success).toBe(false);
    expect(lookupPayloadSchema.safeParse({ ...lookup, pullRequestNumber: 0 }).success).toBe(false);
  });

  it('a claim hands out at most five lookups', () => {
    expect(claimLookupsResponseSchema.safeParse(Array(LOOKUP_CLAIM_MAX).fill(lookup)).success).toBe(
      true,
    );
    expect(
      claimLookupsResponseSchema.safeParse(Array(LOOKUP_CLAIM_MAX + 1).fill(lookup)).success,
    ).toBe(false);
  });

  it('a pull request state result names the state and, when known, the branch position', () => {
    for (const state of ['draft', 'open', 'merged', 'closed', 'missing']) {
      expect(pullRequestStateResultSchema.safeParse({ state }).success).toBe(true);
    }
    expect(
      pullRequestStateResultSchema.safeParse({
        state: 'open',
        behindBy: 0,
        aheadBy: 4,
        mergeable: true,
      }).success,
    ).toBe(true);
    expect(pullRequestStateResultSchema.safeParse({ state: 'ready' }).success).toBe(false);
    expect(pullRequestStateResultSchema.safeParse({ state: 'open', behindBy: -1 }).success).toBe(
      false,
    );
    expect(pullRequestStateResultSchema.safeParse({ state: 'open', extra: 1 }).success).toBe(false);
  });

  it('a merged or missing pull request carries no branch position or verdict, a closed one no verdict', () => {
    for (const state of ['merged', 'missing']) {
      expect(pullRequestStateResultSchema.safeParse({ state, behindBy: 0 }).success).toBe(false);
      expect(pullRequestStateResultSchema.safeParse({ state, mergeable: true }).success).toBe(
        false,
      );
    }
    expect(
      pullRequestStateResultSchema.safeParse({ state: 'closed', behindBy: 1, aheadBy: 1 }).success,
    ).toBe(true);
    expect(
      pullRequestStateResultSchema.safeParse({ state: 'closed', mergeable: true }).success,
    ).toBe(false);
  });

  it('a failure report may carry the pull request state only with preparation_failed', () => {
    const failed = (code: string, pullRequestState?: string) =>
      reportRunStateRequestSchema.safeParse({
        workerId: WORKER_ID,
        state: 'failed',
        failure: { code, detail: 'x' },
        ...(pullRequestState ? { pullRequestState } : {}),
      }).success;
    expect(failed('preparation_failed', 'merged')).toBe(true);
    expect(failed('agent_failed', 'merged')).toBe(false);
    expect(failed('preparation_failed', 'ready')).toBe(false);
  });

  it('an answer is a result of the lookup kind, or a failure with a code and a message', () => {
    expect(
      lookupResultRequestSchema.safeParse({
        workerId: WORKER_ID,
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'merged' },
      }).success,
    ).toBe(true);
    expect(
      lookupResultRequestSchema.safeParse({
        workerId: WORKER_ID,
        ok: false,
        code: 'rate_limited',
        error: 'GitHub asked to wait.',
        retryAfterSeconds: 60,
      }).success,
    ).toBe(true);
    expect(
      lookupResultRequestSchema.safeParse({
        workerId: WORKER_ID,
        ok: true,
        result: { state: 'merged' },
      }).success,
    ).toBe(false);
    expect(
      lookupResultRequestSchema.safeParse({ workerId: WORKER_ID, ok: false, error: 'x' }).success,
    ).toBe(false);
    expect(
      lookupResultRequestSchema.safeParse({
        workerId: WORKER_ID,
        ok: false,
        code: 'failed',
        error: '',
      }).success,
    ).toBe(false);
    expect(
      lookupResultRequestSchema.safeParse({
        workerId: WORKER_ID,
        ok: false,
        code: 'failed',
        error: 'x',
        retryAfterSeconds: 0,
      }).success,
    ).toBe(false);
  });
  describe('Pull request checks', () => {
    const COMMIT = 'c'.repeat(40);
    const check = { name: 'build', state: 'failed', durationSeconds: 61, url: 'https://ci.test/1' };

    it('a draft or open pull request carries its checks with their commit', () => {
      for (const state of ['draft', 'open']) {
        expect(
          pullRequestStateResultSchema.safeParse({
            state,
            checksCommit: COMMIT,
            checks: [check, { ...check, state: 'queued', durationSeconds: undefined }],
          }).success,
        ).toBe(true);
      }
      expect(
        pullRequestStateResultSchema.safeParse({ state: 'open', checksCommit: COMMIT, checks: [] })
          .success,
      ).toBe(true);
      expect(
        pullRequestStateResultSchema.safeParse({ state: 'open', checksUnavailable: true }).success,
      ).toBe(true);
    });

    it('checks come with their commit, not with the unavailable marker, and not for an ended pull request', () => {
      const parse = (result: object) => pullRequestStateResultSchema.safeParse(result).success;
      expect(parse({ state: 'open', checks: [check] })).toBe(false);
      expect(parse({ state: 'open', checksCommit: COMMIT })).toBe(false);
      expect(
        parse({ state: 'open', checksCommit: COMMIT, checks: [], checksUnavailable: true }),
      ).toBe(false);
      for (const state of ['merged', 'closed', 'missing']) {
        expect(parse({ state, checksCommit: COMMIT, checks: [] })).toBe(false);
        expect(parse({ state, checksUnavailable: true })).toBe(false);
      }
    });

    it('a check has a name, a known state, a whole non-negative duration and a web link', () => {
      const parse = (patch: object) =>
        pullRequestStateResultSchema.safeParse({
          state: 'open',
          checksCommit: COMMIT,
          checks: [{ ...check, ...patch }],
        }).success;
      expect(parse({})).toBe(true);
      expect(parse({ name: '' })).toBe(false);
      expect(parse({ state: 'pending' })).toBe(false);
      expect(parse({ durationSeconds: -1 })).toBe(false);
      expect(parse({ durationSeconds: 1.5 })).toBe(false);
      expect(parse({ url: 'javascript:alert(1)' })).toBe(false);
      expect(parse({ url: 'not a link' })).toBe(false);
      expect(parse({ url: 'https://user:token@ci.test/x' })).toBe(false);
      expect(parse({ extra: 1 })).toBe(false);
    });

    it(`carries at most ${PULL_REQUEST_CHECKS_MAX} checks`, () => {
      const parse = (count: number) =>
        pullRequestStateResultSchema.safeParse({
          state: 'open',
          checksCommit: COMMIT,
          checks: Array(count).fill(check),
        }).success;
      expect(parse(PULL_REQUEST_CHECKS_MAX)).toBe(true);
      expect(parse(PULL_REQUEST_CHECKS_MAX + 1)).toBe(false);
    });

    describe('the logs of failed checks', () => {
      const entry = {
        name: 'unit tests',
        url: 'https://ci.test/1',
        logAvailable: true,
        excerpt: 'FAIL a.test.ts',
      };
      const parse = (checks: object[]) =>
        failingCheckLogsResultSchema.safeParse({ commit: COMMIT, checks }).success;

      it('lists each failed check with its excerpt, or why there is none', () => {
        expect(parse([entry])).toBe(true);
        expect(
          parse([{ name: 'deploy', url: 'https://ci.test/2', logAvailable: false, note: 'Gone.' }]),
        ).toBe(true);
        expect(parse([])).toBe(true);
      });

      it('has an excerpt exactly when the log was available', () => {
        expect(parse([{ ...entry, logAvailable: false }])).toBe(false);
        expect(parse([{ name: 'x', url: 'https://ci.test/2', logAvailable: true }])).toBe(false);
      });

      it('caps one excerpt at 16 KiB and all of them together at 64 KiB', () => {
        const big = (length: number) => ({ ...entry, excerpt: 'x'.repeat(length) });
        expect(parse([big(FAILING_CHECK_EXCERPT_MAX_LENGTH)])).toBe(true);
        expect(parse([big(FAILING_CHECK_EXCERPT_MAX_LENGTH + 1)])).toBe(false);
        const full = FAILING_CHECK_EXCERPTS_TOTAL_MAX_LENGTH / FAILING_CHECK_EXCERPT_MAX_LENGTH;
        expect(parse(Array(full).fill(big(FAILING_CHECK_EXCERPT_MAX_LENGTH)))).toBe(true);
        expect(parse([...Array(full).fill(big(FAILING_CHECK_EXCERPT_MAX_LENGTH)), big(1)])).toBe(
          false,
        );
      });

      it('counts the caps in UTF-8 bytes, not characters', () => {
        expect(parse([{ ...entry, excerpt: 'é'.repeat(9_000) }])).toBe(false);
        expect(parse([{ ...entry, excerpt: 'é'.repeat(8_192) }])).toBe(true);
      });

      it('is answered with the kind failing_check_logs only', () => {
        const answer = {
          workerId: WORKER_ID,
          ok: true,
          kind: 'failing_check_logs',
          result: { commit: COMMIT, checks: [entry] },
        };
        expect(lookupResultRequestSchema.safeParse(answer).success).toBe(true);
        expect(
          lookupResultRequestSchema.safeParse({ ...answer, kind: 'pull_request_state' }).success,
        ).toBe(false);
        expect(
          lookupResultRequestSchema.safeParse({
            ...answer,
            kind: 'pull_request_state',
            result: { state: 'open' },
          }).success,
        ).toBe(true);
        expect(
          lookupPayloadSchema.safeParse({
            id: LOOKUP_ID,
            kind: 'failing_check_logs',
            runId: RUN_ID,
            repository: { remoteUrl: 'https://github.com/acme/shop.git' },
            pullRequestNumber: 7,
            runBranch: 'agent/add-store-r0b8e5c2d',
            integrationBranch: 'dev',
          }).success,
        ).toBe(true);
      });
    });
  });
  describe('Review comments', () => {
    const comment = {
      id: 'inline-12',
      author: 'octocat',
      kind: 'inline',
      path: 'src/a.ts',
      line: 3,
      diffContext: '@@ -1 +1 @@\n-a\n+b',
      text: 'Please rename this.',
      createdAt: '2026-11-16T10:00:00.000Z',
    };
    const parse = (comments: unknown[], truncated = false) =>
      reviewCommentsResultSchema.safeParse({ comments, truncated }).success;
    const payload = {
      id: LOOKUP_ID,
      kind: 'review_comments',
      runId: RUN_ID,
      repository: { remoteUrl: 'https://github.com/acme/shop.git' },
      pullRequestNumber: 7,
      runBranch: 'agent/add-store-r0b8e5c2d',
      integrationBranch: 'dev',
    };

    it('accepts the three kinds of comment', () => {
      expect(
        parse([
          comment,
          {
            id: 'review-3',
            author: 'octocat',
            kind: 'review',
            verdict: 'approved',
            text: '',
            createdAt: comment.createdAt,
          },
          {
            id: 'conversation-4',
            author: 'octocat',
            kind: 'conversation',
            text: 'Hi',
            createdAt: comment.createdAt,
          },
        ]),
      ).toBe(true);
    });

    it('keeps a file, line and diff context to inline comments and a verdict to reviews', () => {
      expect(parse([{ ...comment, kind: 'conversation' }])).toBe(false);
      expect(parse([{ ...comment, path: undefined }])).toBe(false);
      expect(parse([{ ...comment, verdict: 'approved' }])).toBe(false);
      expect(parse([{ ...comment, id: 'bad id' }])).toBe(false);
    });

    it('refuses repeated ids and more than 100 comments', () => {
      expect(parse([comment, comment])).toBe(false);
      const many = Array.from({ length: REVIEW_COMMENTS_MAX + 1 }, (_, n) => ({
        ...comment,
        id: `inline-${n + 1}`,
      }));
      expect(parse(many)).toBe(false);
      expect(parse(many.slice(0, REVIEW_COMMENTS_MAX))).toBe(true);
    });

    it('caps a text at 8 KiB in UTF-8 bytes and a cut text sets truncated', () => {
      expect(parse([{ ...comment, text: 'x'.repeat(REVIEW_COMMENT_TEXT_MAX_BYTES) }])).toBe(true);
      expect(parse([{ ...comment, text: 'x'.repeat(REVIEW_COMMENT_TEXT_MAX_BYTES + 1) }])).toBe(
        false,
      );
      expect(parse([{ ...comment, text: 'é'.repeat(REVIEW_COMMENT_TEXT_MAX_BYTES / 2 + 1) }])).toBe(
        false,
      );
      expect(parse([{ ...comment, textCut: true }], false)).toBe(false);
      expect(parse([{ ...comment, textCut: true }], true)).toBe(true);
    });

    it('is claimed with what to load, and answered with the kind review_comments only', () => {
      const reviewComments = { scope: 'since_last_result', since: '2026-11-16T09:00:00.000Z' };
      expect(lookupPayloadSchema.safeParse({ ...payload, reviewComments }).success).toBe(true);
      expect(
        lookupPayloadSchema.safeParse({ ...payload, reviewComments: { scope: 'unresolved' } })
          .success,
      ).toBe(true);
      expect(lookupPayloadSchema.safeParse(payload).success).toBe(false);
      expect(
        lookupPayloadSchema.safeParse({ ...payload, reviewComments: { scope: 'all' } }).success,
      ).toBe(false);
      expect(
        lookupPayloadSchema.safeParse({ ...payload, kind: 'pull_request_state', reviewComments })
          .success,
      ).toBe(false);
      const answer = {
        workerId: WORKER_ID,
        ok: true,
        kind: 'review_comments',
        result: { comments: [comment], truncated: false },
      };
      expect(lookupResultRequestSchema.safeParse(answer).success).toBe(true);
      expect(
        lookupResultRequestSchema.safeParse({ ...answer, kind: 'failing_check_logs' }).success,
      ).toBe(false);
    });
  });
});

describe('bringing a Run branch up to date', () => {
  const claim = {
    runId: '0b8e5c2d-3f4a-4b6c-8d9e-1a2b3c4d5e6f',
    projectId: '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
    provider: 'claude_code',
    ...AGENT_FIELDS,
    task: 'Add the thing',
    startCommit: 'a'.repeat(40),
    repository: { remoteUrl: 'https://github.com/o/r.git' },
    integrationBranch: 'main',
    kind: 'resume',
    studioPaths: [],
    runBranch: 'agent/add-the-thing-r0b8e5c2d',
    sessionRef: 'session-1',
    answer: 'Keep our version of the config.',
    resumeReason: 'bring_up_to_date',
    followUpNumber: 1,
    bringUpToDate: true,
    nextSeq: 12,
    limits: { stepMinutes: 30, maxSteps: 10 },
    completedSteps: 2,
  };

  it('is a resume claim inside a Follow-up that carries the flag', () => {
    expect(runPayloadSchema.parse(claim)).toEqual(claim);
    const { bringUpToDate: _flag, ...withoutFlag } = claim;
    void _flag;
    expect(runPayloadSchema.safeParse(withoutFlag).success).toBe(false);
    const { followUpNumber: _number, ...withoutNumber } = claim;
    void _number;
    expect(runPayloadSchema.safeParse(withoutNumber).success).toBe(false);
    expect(runPayloadSchema.safeParse({ ...claim, resumeReason: 'answer' }).success).toBe(true);
    expect(runPayloadSchema.safeParse({ ...claim, bringUpToDate: false }).success).toBe(false);
    expect(runPayloadSchema.safeParse({ ...claim, kind: 'start' }).success).toBe(false);
  });

  it('carries a pending update only with a resume claim', () => {
    const pending = { baseCommit: 'a'.repeat(40), pushedCommit: 'b'.repeat(40) };
    expect(runPayloadSchema.safeParse({ ...claim, pendingUpdate: pending }).success).toBe(true);
    expect(
      runPayloadSchema.safeParse({ ...claim, pendingUpdate: { baseCommit: 'a'.repeat(40) } })
        .success,
    ).toBe(true);
    expect(
      runPayloadSchema.safeParse({ ...claim, pendingUpdate: { baseCommit: 'abc' } }).success,
    ).toBe(false);
    expect(
      runPayloadSchema.safeParse({
        ...claim,
        kind: 'deliver',
        sessionRef: undefined,
        answer: undefined,
        resumeReason: undefined,
        followUpNumber: undefined,
        bringUpToDate: undefined,
        pendingUpdate: pending,
      }).success,
    ).toBe(false);
  });

  it('carries where the merge started, only with the flag, and the last merged commit', () => {
    const start = { updateBase: 'a'.repeat(40), updateTip: 'b'.repeat(40) };
    expect(runPayloadSchema.safeParse({ ...claim, ...start }).success).toBe(true);
    const { bringUpToDate: _flag, resumeReason: _reason, ...plain } = claim;
    void _flag;
    void _reason;
    const followUp = { ...plain, resumeReason: 'follow_up' };
    expect(runPayloadSchema.safeParse({ ...followUp, ...start }).success).toBe(false);
    expect(runPayloadSchema.safeParse({ ...claim, updateTip: 'abc' }).success).toBe(false);
    const merged = { mergedIntegrationCommit: 'c'.repeat(40) };
    expect(runPayloadSchema.safeParse({ ...followUp, ...merged }).success).toBe(true);
    expect(
      runPayloadSchema.safeParse({
        ...claim,
        kind: 'start',
        runBranch: undefined,
        sessionRef: undefined,
        answer: undefined,
        resumeReason: undefined,
        followUpNumber: undefined,
        bringUpToDate: undefined,
        nextSeq: undefined,
        ...merged,
      }).success,
    ).toBe(false);
  });

  it('takes the note as long as a Follow-up', () => {
    expect(
      runPayloadSchema.safeParse({ ...claim, answer: 'a'.repeat(FOLLOW_UP_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      runPayloadSchema.safeParse({ ...claim, answer: 'a'.repeat(FOLLOW_UP_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  describe('the state report', () => {
    const valid = (body: object) =>
      reportRunStateRequestSchema.safeParse({ workerId: WORKER_ID, ...body }).success;
    const merged = 'b'.repeat(40);
    const delivery = { outcome: 'none' };

    it('names where the merge started with running only', () => {
      const started = { baseCommit: 'a'.repeat(40), integrationCommit: merged };
      expect(valid({ state: 'running', bringUpToDateStarted: started })).toBe(true);
      expect(valid({ state: 'succeeded', delivery, bringUpToDateStarted: started })).toBe(false);
      expect(
        valid({ state: 'running', bringUpToDateStarted: { ...started, baseCommit: 'abc' } }),
      ).toBe(false);
      expect(
        valid({ state: 'running', bringUpToDateStarted: { baseCommit: started.baseCommit } }),
      ).toBe(false);
      // The merged commit is Studio's to record once the part succeeded: a worker cannot name it.
      expect(valid({ state: 'running', mergedCommit: merged })).toBe(false);
    });

    it('reports a request that changed nothing as succeeded without a delivery, with a reason', () => {
      expect(valid({ state: 'succeeded', unchanged: true })).toBe(true);
      expect(
        valid({ state: 'succeeded', unchanged: true, unchangedDetail: 'Could not fetch.' }),
      ).toBe(true);
      expect(valid({ state: 'succeeded', unchanged: true, delivery })).toBe(false);
      expect(valid({ state: 'running', unchanged: true })).toBe(false);
      expect(valid({ state: 'succeeded', unchanged: false })).toBe(false);
      expect(valid({ state: 'succeeded', delivery, unchangedDetail: 'x' })).toBe(false);
      expect(valid({ state: 'succeeded', unchanged: true, unchangedDetail: '' })).toBe(false);
      expect(valid({ state: 'succeeded' })).toBe(false);
    });
  });
});
