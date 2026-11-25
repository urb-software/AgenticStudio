import { describe, expect, it, vi } from 'vitest';
import type { RunStartPoints } from '../../../../../projects/contracts/index.js';
import {
  DefinitionsProjectRunError,
  RunProjectNotFoundError,
} from '../../../../domain/errors/run-errors.js';
import { inMemoryExecutions } from '../../../__tests__/in-memory-executions.js';
import { FakeProjectKinds } from '../../../ports/__tests__/fake-project-kinds.js';
import { ListProjectRunsHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

function setUp(answer: Awaited<ReturnType<RunStartPoints['forProject']>>) {
  const kinds = new FakeProjectKinds();
  const executions = inMemoryExecutions();
  const forProject = vi.fn<RunStartPoints['forProject']>(() => Promise.resolve(answer));
  const handler = new ListProjectRunsHandler(
    kinds,
    executions.runs,
    { forProject },
    executions.preparedFollowUps,
  );
  return { kinds, executions, forProject, handler };
}

describe('ListProjectRunsHandler', () => {
  it('lists the Runs of an ordinary Project', async () => {
    const { executions, handler } = setUp({ status: 'no_repository' });
    await executions.runs.start({
      projectId: PROJECT,
      provider: 'claude_code',
      task: 'Add a health check',
      startCommit: 'a'.repeat(40),
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });

    await expect(handler.execute({ projectId: PROJECT })).resolves.toHaveLength(1);
  });

  it('refuses the definitions Repository before it reads anything else', async () => {
    const { kinds, forProject, handler } = setUp({ status: 'no_repository' });
    kinds.kind = 'definitions';

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      DefinitionsProjectRunError,
    );
    expect(forProject).not.toHaveBeenCalled();
  });

  it('rejects an unknown project', async () => {
    const { handler } = setUp({ status: 'project_not_found' });

    await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
      RunProjectNotFoundError,
    );
  });
});
