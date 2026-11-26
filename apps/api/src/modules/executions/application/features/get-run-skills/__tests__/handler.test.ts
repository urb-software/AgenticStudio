import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSkills, RunSkillFilesRead } from '../../../../../agents/contracts/index.js';
import type { Run } from '../../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import {
  RunNotFoundError,
  RunNotHeldError,
  SkillsInvalidError,
  SkillsReadFailedError,
  SkillsUnavailableError,
} from '../../../../domain/errors/run-errors.js';
import { GetRunSkillsHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-25T12:00:00.000Z');
const COMMIT = 'b'.repeat(40);

describe('GetRunSkillsHandler', () => {
  let runs: InMemoryRunRepository;
  let files: ReturnType<typeof vi.fn<AgentSkills['files']>>;
  let describe_: ReturnType<typeof vi.fn<AgentSkills['describe']>>;
  let handler: GetRunSkillsHandler;

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
    skills: ['lint', 'notes'],
  };

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    files = vi.fn<AgentSkills['files']>(() =>
      Promise.resolve({ status: 'found', skills: [], omitted: [] }),
    );
    describe_ = vi.fn<AgentSkills['describe']>(() =>
      Promise.resolve({ status: 'found', skills: [] }),
    );
    handler = new GetRunSkillsHandler(runs, { files, describe: describe_ });
  });

  it('answers the recorded commit and no skills for a built-in agent, reading nothing', async () => {
    const run = await start();

    await expect(handler.execute({ runId: run.id, workerId: WORKER })).resolves.toEqual({
      commit: null,
      skills: [],
      omitted: [],
    });
    expect(files).not.toHaveBeenCalled();
  });

  it('answers the commit and no skills for a definitions agent without skills, reading nothing', async () => {
    const run = await start({ ...reviewer, skills: [] });

    await expect(handler.execute({ runId: run.id, workerId: WORKER })).resolves.toEqual({
      commit: COMMIT,
      skills: [],
      omitted: [],
    });
    expect(files).not.toHaveBeenCalled();
  });

  it('reads the skills the Run recorded, at the commit it recorded, nothing else', async () => {
    const run = await start(reviewer);
    const content = new Uint8Array([1, 2, 0xff]);
    files.mockResolvedValueOnce({
      status: 'found',
      skills: [{ name: 'lint', files: [{ path: 'SKILL.md', executable: false, content }] }],
      omitted: ['notes'],
    });

    await expect(handler.execute({ runId: run.id, workerId: WORKER })).resolves.toEqual({
      commit: COMMIT,
      skills: [{ name: 'lint', files: [{ path: 'SKILL.md', executable: false, content }] }],
      omitted: ['notes'],
    });
    expect(files).toHaveBeenCalledExactlyOnceWith(['lint', 'notes'], COMMIT);
  });

  it('refuses a Run that does not exist, and one this worker does not hold, before reading', async () => {
    const run = await start(reviewer);

    await expect(
      handler.execute({ runId: '9c3e4d6a-1d9f-4e5c-8043-2f7b8c9d0e1f', workerId: WORKER }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(handler.execute({ runId: 'not-an-id', workerId: WORKER })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
    await expect(handler.execute({ runId: run.id, workerId: OTHER_WORKER })).rejects.toBeInstanceOf(
      RunNotHeldError,
    );
    expect(files).not.toHaveBeenCalled();
  });

  it.each<[RunSkillFilesRead, new (...args: never[]) => Error]>([
    [{ status: 'unavailable' }, SkillsUnavailableError],
    [{ status: 'unreadable' }, SkillsReadFailedError],
    [
      {
        status: 'invalid',
        problems: [{ skill: 'lint', code: 'shell_line', path: 'SKILL.md' }],
      },
      SkillsInvalidError,
    ],
  ])('maps the read %j to its error', async (answer, error) => {
    const run = await start(reviewer);
    files.mockResolvedValueOnce(answer);

    await expect(handler.execute({ runId: run.id, workerId: WORKER })).rejects.toBeInstanceOf(
      error,
    );
  });

  it('names skills, codes and paths only in the detail of an invalid answer', async () => {
    const run = await start(reviewer);
    files.mockResolvedValueOnce({
      status: 'invalid',
      problems: [{ skill: 'lint', code: 'shell_line', path: 'SKILL.md' }],
    });

    await expect(handler.execute({ runId: run.id, workerId: WORKER })).rejects.toMatchObject({
      detail: "The agent's skills fail the validation: shell_line (lint/SKILL.md).",
    });
  });
});
