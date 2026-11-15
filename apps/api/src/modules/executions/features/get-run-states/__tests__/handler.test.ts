import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { GetRunStatesHandler } from '../handler.js';

// Issue #98: the agent worker asks which of its Runs are final, and since when, to apply the
// retention rules to their Working copies.
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT = '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:30:00.000Z');

describe('GetRunStatesHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: GetRunStatesHandler;

  const add = (projectId: string) =>
    runs.add({
      projectId,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    handler = new GetRunStatesHandler(runs);
  });

  it('answers the state of each asked Run, and when a final one finished', async () => {
    const finished = await add(PROJECT);
    const active = await add(OTHER_PROJECT);
    const queued = await add(PROJECT);
    await runs.claimNext(WORKER, T0);
    await runs.transitionClaimed({
      runId: finished.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'preparation_failed', detail: 'x' },
      now: T1,
    });
    await runs.claimNext(WORKER, T1);

    const states = await handler.execute([finished.id, active.id, queued.id]);

    expect(states).toEqual(
      expect.arrayContaining([
        { runId: finished.id, state: 'failed', finishedAt: T1 },
        { runId: active.id, state: 'preparing', finishedAt: null },
        { runId: queued.id, state: 'queued', finishedAt: null },
      ]),
    );
    expect(states).toHaveLength(3);
  });

  it('leaves out ids that name no Run', async () => {
    const run = await add(PROJECT);

    expect(await handler.execute([randomUUID(), run.id])).toEqual([
      { runId: run.id, state: 'queued', finishedAt: null },
    ]);
  });
});
