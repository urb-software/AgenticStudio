import type { Run } from '../../entities/run.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

export const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
export const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
export const T0 = new Date('2026-11-16T12:00:00.000Z');
export const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const WORKING_COPY = {
  runBranch: 'agent/x-r0b8e5c2d',
  commits: [{ id: 'a'.repeat(40), subject: 'First' }],
  hasUncommittedChanges: false,
};

/**
 * A Run `WORKER` carried to `succeeded`; with `delivered: false` it ends without a pull request.
 */
export async function deliveredRun(
  runs: InMemoryRunRepository,
  options: { delivered?: boolean } = {},
): Promise<Run> {
  const added = await runs.start({
    projectId: PROJECT,
    provider: 'claude_code',
    task: 'Add a health check',
    startCommit: 'a',
    remoteUrl: 'https://github.com/acme/shop.git',
    limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    integrationBranch: 'dev',
  });
  await runs.claimNext(WORKER, T0);
  await runs.transitionClaimed({
    runId: added.id,
    workerId: WORKER,
    from: 'preparing',
    to: 'running',
    failure: null,
    cancelRequested: false,
    now: T0,
  });
  await runs.appendStep(
    added.id,
    WORKER,
    { kind: 'start', result: { outcome: 'done', summary: 'Done.' }, sessionRef: 'session-1' },
    WORKING_COPY,
    [],
    T0,
  );
  await runs.transitionClaimed({
    runId: added.id,
    workerId: WORKER,
    from: 'running',
    to: 'succeeded',
    failure: null,
    delivery:
      options.delivered === false
        ? { outcome: 'none' }
        : { outcome: 'delivered', pullRequest: PULL_REQUEST },
    cancelRequested: false,
    now: T0,
  });
  return (await runs.findById(added.id))!;
}
