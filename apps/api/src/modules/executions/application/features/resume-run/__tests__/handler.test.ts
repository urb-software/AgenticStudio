import { beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../../../../domain/entities/run.js';
import { HandOutRule } from '../../../../domain/value-objects/hand-out-rule.js';
import { RunConversation } from '../../../../domain/value-objects/run-conversation.js';
import { type RunFailure } from '../../../../domain/value-objects/run-failure.js';
import {
  RunNotResumableError,
  RunSlotTakenError,
  RunNotFoundError,
} from '../../../../domain/errors/run-errors.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { ResumeRunHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const UNKNOWN_RUN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T17:00:00.000Z');
const WORKING_COPY = { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false };
const USAGE_LIMIT: RunFailure = {
  code: 'usage_limit',
  detail: 'The Claude Code usage limit was reached; it resets at 2026-11-15T17:00:00.000Z.',
};

const OTHER_PROJECT_1 = '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_PROJECT_2 = '5b4d0e3a-6f7c-4d8e-9fa0-1b2c3d4e5f60';
const NEW_RUN = {
  projectId: PROJECT,
  provider: 'claude_code' as const,
  task: 'x',
  startCommit: 'a',
  remoteUrl: 'https://git.example.test/a.git',
  limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
  integrationBranch: 'dev',
};

describe('ResumeRunHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: ResumeRunHandler;
  let run: Run;

  async function stop(failure: RunFailure, sessionRef: string | null = 'session-1') {
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'running',
      to: 'failed',
      failure,
      workingCopy: WORKING_COPY,
      sessionRef,
      cancelRequested: false,
      now: T0,
    });
  }

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new ResumeRunHandler(runs, { now: () => T1 });
    await runs.start(NEW_RUN);
    run = (await runs.claimNext(WORKER, T0))!;
  });

  it('queues the Run to resume its session with "Continue where you stopped."', async () => {
    await stop(USAGE_LIMIT);

    expect(await handler.execute({ runId: run.id })).toBeUndefined();

    const resumed = (await runs.findById(run.id))!;
    expect(resumed).toMatchObject({
      workingCopy: WORKING_COPY,
      lifecycle: { state: 'queued', failure: null, finishedAt: null },
      claim: { sessionRef: 'session-1' },
    });
    expect(resumed.conversation.messages).toEqual([
      { kind: 'answer', text: 'Continue where you stopped.', at: T1 },
    ]);
    expect(RunConversation.USAGE_LIMIT_RESUME_TEXT).toBe('Continue where you stopped.');
  });

  it('hands it only to the worker that started it, as a resume', async () => {
    await stop(USAGE_LIMIT);
    await handler.execute({ runId: run.id });

    expect(await runs.claimNext(OTHER_WORKER, T1)).toBeNull();
    expect(await runs.claimNext(WORKER, T1)).toMatchObject({
      id: run.id,
      lifecycle: { state: 'preparing' },
    });
  });

  it('refuses a second resume once the Run is queued', async () => {
    await stop(USAGE_LIMIT);
    await handler.execute({ runId: run.id });

    await expect(handler.execute({ runId: run.id })).rejects.toBeInstanceOf(RunNotResumableError);
  });

  it.each<[string, RunFailure, string | null]>([
    ['another failure', { code: 'agent_failed', detail: 'x' }, 'session-1'],
    ['the usage limit without a session', USAGE_LIMIT, null],
  ])('refuses a Run with %s', async (_case, failure, sessionRef) => {
    await stop(failure, sessionRef);

    await expect(handler.execute({ runId: run.id })).rejects.toBeInstanceOf(RunNotResumableError);
    expect((await runs.findById(run.id))?.lifecycle.state).toBe('failed');
  });

  it("refuses once a supplied Environment file's snapshot is gone (no redaction for the step)", async () => {
    await runs.attachEnvironmentFile(run.id, WORKER, { path: '.env', secretRef: 'snapshot-1' });
    await stop(USAGE_LIMIT);
    await runs.clearEnvironmentFileSecret(run.id, 'snapshot-1');

    await expect(handler.execute({ runId: run.id })).rejects.toBeInstanceOf(RunNotResumableError);
  });

  it('resumes while the snapshot is kept', async () => {
    await runs.attachEnvironmentFile(run.id, WORKER, { path: '.env', secretRef: 'snapshot-1' });
    await stop(USAGE_LIMIT);

    await handler.execute({ runId: run.id });
    expect((await runs.findById(run.id))?.lifecycle.state).toBe('queued');
  });

  it("refuses while another Run holds the project's place, and resumes once it has ended", async () => {
    await stop(USAGE_LIMIT);
    await runs.start({ ...NEW_RUN, task: 'other' });
    const other = (await runs.claimNext(WORKER, T1))!;

    await expect(handler.execute({ runId: run.id })).rejects.toEqual(
      new RunSlotTakenError('project'),
    );
    await expect(handler.execute({ runId: run.id })).rejects.toThrow(
      'Another run of this project is active. Resume this run when that run has ended.',
    );
    expect((await runs.findById(run.id))?.lifecycle.state).toBe('failed');

    await runs.transitionClaimed({
      runId: other.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'agent_failed', detail: 'x' },
      cancelRequested: false,
      now: T1,
    });
    await handler.execute({ runId: run.id });
    expect((await runs.findById(run.id))?.lifecycle.state).toBe('queued');
  });

  it("refuses while the server's places are taken", async () => {
    await stop(USAGE_LIMIT);
    for (const project of [OTHER_PROJECT_1, OTHER_PROJECT_2]) {
      await runs.start({ ...NEW_RUN, projectId: project });
      await runs.claimNext(OTHER_WORKER, T1);
    }

    await expect(handler.execute({ runId: run.id })).rejects.toEqual(
      new RunSlotTakenError('server', HandOutRule.MAX_PLACES),
    );
  });

  it('refuses a Run that has not failed', async () => {
    await expect(handler.execute({ runId: run.id })).rejects.toBeInstanceOf(RunNotResumableError);
  });

  it.each([UNKNOWN_RUN, 'not-a-uuid'])('404s an unknown Run: %s', async (id) => {
    await expect(handler.execute({ runId: id })).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
