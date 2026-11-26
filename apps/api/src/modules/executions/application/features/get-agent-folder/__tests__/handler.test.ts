import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFolderRead, AgentFolders } from '../../../../../agents/contracts/index.js';
import type { Run } from '../../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import {
  AgentFolderCutError,
  AgentFolderInvalidError,
  AgentFolderReadFailedError,
  AgentFolderUnavailableError,
  RunNotFoundError,
  RunNotHeldError,
} from '../../../../domain/errors/run-errors.js';
import { GetAgentFolderHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-25T12:00:00.000Z');
const COMMIT = 'b'.repeat(40);

describe('GetAgentFolderHandler', () => {
  let runs: InMemoryRunRepository;
  let folderAt: ReturnType<typeof vi.fn<AgentFolders['folderAt']>>;
  let handler: GetAgentFolderHandler;

  const start = async (
    agent?: Parameters<InMemoryRunRepository['start']>[0]['agent'],
  ): Promise<Run> => {
    await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a'.repeat(40),
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
      ...(agent ? { agent } : {}),
    });
    return (await runs.claimNext(WORKER, T0))!;
  };

  const reviewer = {
    name: 'reviewer',
    source: 'definitions' as const,
    commit: COMMIT,
    provider: 'codex' as const,
    model: 'default',
    instructions: 'Review.',
    skills: [] as string[],
  };

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    folderAt = vi.fn<AgentFolders['folderAt']>(() =>
      Promise.resolve({ status: 'found', files: [] }),
    );
    handler = new GetAgentFolderHandler(runs, { folderAt });
  });

  it('answers no commit and no files for a built-in agent, without reading any folder', async () => {
    const run = await start();

    await expect(handler.execute({ runId: run.id, workerId: WORKER })).resolves.toEqual({
      commit: null,
      files: [],
    });
    expect(folderAt).not.toHaveBeenCalled();
  });

  it('reads the folder of the agent and the commit the Run recorded, nothing else', async () => {
    const run = await start(reviewer);
    const content = new Uint8Array([1, 2, 0xff]);
    folderAt.mockResolvedValueOnce({
      status: 'found',
      files: [{ path: 'scripts/run.sh', executable: true, content }],
    });

    await expect(handler.execute({ runId: run.id, workerId: WORKER })).resolves.toEqual({
      commit: COMMIT,
      files: [{ path: 'scripts/run.sh', executable: true, content }],
    });
    expect(folderAt).toHaveBeenCalledWith('reviewer', COMMIT);
  });

  it('answers only the worker that holds the Run, and only a Run that exists', async () => {
    const run = await start(reviewer);

    await expect(handler.execute({ runId: run.id, workerId: OTHER_WORKER })).rejects.toThrow(
      RunNotHeldError,
    );
    await expect(
      handler.execute({ runId: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f', workerId: WORKER }),
    ).rejects.toThrow(RunNotFoundError);
    await expect(handler.execute({ runId: 'not-a-uuid', workerId: WORKER })).rejects.toThrow(
      RunNotFoundError,
    );
    expect(folderAt).not.toHaveBeenCalled();
  });

  it('refuses with the reasons when the folder is gone or fails the validation', async () => {
    const run = await start(reviewer);
    folderAt.mockResolvedValueOnce({ status: 'unavailable' } satisfies AgentFolderRead);
    await expect(handler.execute({ runId: run.id, workerId: WORKER })).rejects.toThrow(
      AgentFolderUnavailableError,
    );

    folderAt.mockResolvedValueOnce({
      status: 'invalid',
      problems: [
        { code: 'cli_config_path', path: 'CLAUDE.md', message: 'The path "CLAUDE.md" is hidden.' },
      ],
    });
    await expect(handler.execute({ runId: run.id, workerId: WORKER })).rejects.toThrow(
      AgentFolderInvalidError,
    );
  });

  it('tells a read that failed now, or a cut listing, from a folder that is gone', async () => {
    const run = await start(reviewer);
    folderAt.mockResolvedValueOnce({ status: 'unreadable', reason: 'read_failed' });
    await expect(handler.execute({ runId: run.id, workerId: WORKER })).rejects.toThrow(
      AgentFolderReadFailedError,
    );

    folderAt.mockResolvedValueOnce({ status: 'unreadable', reason: 'tree_cut' });
    await expect(handler.execute({ runId: run.id, workerId: WORKER })).rejects.toThrow(
      AgentFolderCutError,
    );
  });
});
