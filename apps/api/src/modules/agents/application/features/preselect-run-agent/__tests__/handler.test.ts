import { describe, expect, it } from 'vitest';
import type {
  ProjectDefaultAgent,
  ProjectDefaultAgents,
} from '../../../../../projects/contracts/index.js';
import { PreselectRunAgentHandler } from '../handler.js';

const AGENTS = [
  { name: 'default-claude-code', usable: true },
  { name: 'reviewer', usable: true },
  { name: 'broken', usable: false },
];

const handlerFor = (stored: ProjectDefaultAgent) => {
  const defaults: ProjectDefaultAgents = { forProject: () => Promise.resolve(stored) };
  return new PreselectRunAgentHandler(defaults);
};

describe('PreselectRunAgentHandler', () => {
  it('chooses the stored default of the Project when it is usable', async () => {
    await expect(
      handlerFor({ status: 'found', agent: 'reviewer' }).execute({
        projectId: 'p',
        agents: AGENTS,
      }),
    ).resolves.toEqual({ status: 'chosen', agent: 'reviewer', reason: null });
  });

  it('chooses the built-in Default agent when the Project names none', async () => {
    await expect(
      handlerFor({ status: 'found', agent: null }).execute({ projectId: 'p', agents: AGENTS }),
    ).resolves.toEqual({ status: 'chosen', agent: 'default-claude-code', reason: null });
  });

  it('judges usability where it reads, not where it was stored', async () => {
    const chosen = await handlerFor({ status: 'found', agent: 'broken' }).execute({
      projectId: 'p',
      agents: AGENTS,
    });

    expect(chosen).toMatchObject({ status: 'chosen', agent: 'default-claude-code' });
    expect(chosen).toEqual(expect.objectContaining({ reason: expect.stringContaining('broken') }));
  });

  it('passes an unknown project on', async () => {
    await expect(
      handlerFor({ status: 'project_not_found' }).execute({ projectId: 'p', agents: AGENTS }),
    ).resolves.toEqual({ status: 'project_not_found' });
  });
});
