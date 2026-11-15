import { beforeEach, describe, expect, it } from 'vitest';
import type { RunStartPoint, RunStartPoints } from '../../../../projects/contracts/index.js';
import { RepositoryNotReadyError, RunProjectNotFoundError } from '../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { StartRunHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HEAD = 'd'.repeat(40);

describe('StartRunHandler', () => {
  let runs: InMemoryRunRepository;
  let startPoint: RunStartPoint;

  const startPoints: RunStartPoints = { forProject: () => Promise.resolve(startPoint) };
  const start = () =>
    new StartRunHandler(runs, startPoints).execute({
      projectId: PROJECT,
      provider: 'codex',
      task: 'Fix the login bug',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    startPoint = { status: 'ready', startCommit: HEAD };
  });

  it('queues a Run that starts from the current integration branch commit', async () => {
    const run = await start();

    expect(run).toMatchObject({
      projectId: PROJECT,
      provider: 'codex',
      task: 'Fix the login bug',
      state: 'queued',
      startCommit: HEAD,
      startedAt: null,
      finishedAt: null,
      failure: null,
    });
    expect(await runs.findById(run.id)).toEqual(run);
  });

  it('rejects an unknown project', async () => {
    startPoint = { status: 'project_not_found' };

    await expect(start()).rejects.toBeInstanceOf(RunProjectNotFoundError);
    expect(runs.runs).toEqual([]);
  });

  it.each([
    ['no_repository', 'no_repository'],
    ['repository_not_ready', 'not_ready'],
  ] as const)('rejects a project whose start point is %s', async (status, reason) => {
    startPoint = { status };

    await expect(start()).rejects.toEqual(new RepositoryNotReadyError(reason));
    expect(runs.runs).toEqual([]);
  });
});
