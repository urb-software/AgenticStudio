import { beforeEach, describe, expect, it } from 'vitest';
import { type RunSnapshot } from '../../../../domain/entities/run-snapshot.js';
import { RunNotWaitingError, RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { AnswerRunHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:30:00.000Z');
const WORKING_COPY = { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false };
const QUESTION = { text: 'Which database?', options: ['PostgreSQL', 'SQLite'] };

describe('AnswerRunHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: AnswerRunHandler;
  let run: RunSnapshot;

  async function ask() {
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    await runs.appendStep(
      run.id,
      WORKER,
      {
        kind: 'start',
        result: { outcome: 'needs_input', summary: 'Stuck.', question: QUESTION },
        question: QUESTION,
        sessionRef: 'session-1',
      },
      WORKING_COPY,
      [],
      T0,
    );
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'running',
      to: 'waiting_for_operator',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
  }

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new AnswerRunHandler(runs, { now: () => T1 });
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

  it('stores the answer after the question and queues the Run to resume', async () => {
    await ask();

    expect(await handler.execute({ runId: run.id, text: 'PostgreSQL' })).toBeUndefined();

    const answered = (await runs.findById(run.id))!.snapshot();
    expect(answered).toMatchObject({ state: 'queued', waitingSince: null });
    expect(answered.messages).toEqual([
      { kind: 'question', question: QUESTION, at: T0 },
      { kind: 'answer', text: 'PostgreSQL', at: T1 },
    ]);
  });

  it('refuses a second answer: the Run is no longer waiting', async () => {
    await ask();
    await handler.execute({ runId: run.id, text: 'PostgreSQL' });

    const error = await handler
      .execute({ runId: run.id, text: 'SQLite' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunNotWaitingError);
    expect((error as RunNotWaitingError).state).toBe('queued');
    expect((await runs.findById(run.id))?.conversation.messages).toHaveLength(2);
  });

  it('refuses an answer to a Run that is not waiting, e.g. running or cancelled', async () => {
    await expect(handler.execute({ runId: run.id, text: 'x' })).rejects.toBeInstanceOf(
      RunNotWaitingError,
    );

    await ask();
    await runs.cancelUnheld(
      run.id,
      'waiting_for_operator',
      { by: 'operator', reason: 'Cancelled by the operator.' },
      T1,
    );
    const error = await handler
      .execute({ runId: run.id, text: 'x' })
      .catch((caught: unknown) => caught);
    expect((error as RunNotWaitingError).state).toBe('cancelled');
  });

  it('rejects an unknown Run, also for an id that is not a UUID', async () => {
    await expect(handler.execute({ runId: 'nope', text: 'x' })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
    await expect(
      handler.execute({ runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b', text: 'x' }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
