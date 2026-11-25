import { AGENT_NAME_PATTERN } from '@agentic-studio/agent-definitions';
import { RUN_AGENT_NAME_MAX_LENGTH, RUN_AGENT_NAME_PATTERN } from '@agentic-studio/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DefinitionsProjectError,
  ProjectNotFoundError,
} from '../../../../domain/errors/project-errors.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { AgentName, InvalidAgentNameError } from '../../../../domain/value-objects/agent-name.js';
import { SetDefaultAgentHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';
const UNKNOWN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('SetDefaultAgentHandler', () => {
  let projects: InMemoryProjectRepository;
  let set: SetDefaultAgentHandler;
  const stored = (id: string) => projects.projects.get(id)?.defaultAgent;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    set = new SetDefaultAgentHandler(projects);
  });

  it('pins the name syntax to the one of the agent definitions, in the domain and the claim', () => {
    expect(AgentName.PATTERN.source).toBe(AGENT_NAME_PATTERN.source);
    expect(RUN_AGENT_NAME_PATTERN.source).toBe(AGENT_NAME_PATTERN.source);
    expect(RUN_AGENT_NAME_PATTERN.test('a'.repeat(RUN_AGENT_NAME_MAX_LENGTH))).toBe(true);
    expect(RUN_AGENT_NAME_PATTERN.test('a'.repeat(RUN_AGENT_NAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('names no default agent at first', () => {
    expect(stored(PROJECT)).toBeNull();
  });

  it('stores the name and answers the project', async () => {
    const changed = await set.execute({ projectId: PROJECT, agent: 'reviewer' });

    expect(changed).toMatchObject({ id: PROJECT, defaultAgent: 'reviewer', mergeMethod: 'squash' });
    expect(stored(PROJECT)).toBe('reviewer');
  });

  it('judges the syntax only: a name that no agent has is stored', async () => {
    await expect(
      set.execute({ projectId: PROJECT, agent: 'no-such-agent' }),
    ).resolves.toMatchObject({ defaultAgent: 'no-such-agent' });
  });

  it('clears the default with null', async () => {
    await set.execute({ projectId: PROJECT, agent: 'reviewer' });

    await set.execute({ projectId: PROJECT, agent: null });

    expect(stored(PROJECT)).toBeNull();
  });

  it.each(['', 'Reviewer', '-reviewer', 'a b', 'a'.repeat(65)])(
    'refuses the invalid name %j and keeps the stored one',
    async (agent) => {
      await set.execute({ projectId: PROJECT, agent: 'reviewer' });

      await expect(set.execute({ projectId: PROJECT, agent })).rejects.toBeInstanceOf(
        InvalidAgentNameError,
      );
      expect(stored(PROJECT)).toBe('reviewer');
    },
  );

  it('refuses the definitions Repository, which accepts no Run', async () => {
    await expect(set.execute({ projectId: DEFINITIONS, agent: 'reviewer' })).rejects.toBeInstanceOf(
      DefinitionsProjectError,
    );
    await expect(set.execute({ projectId: DEFINITIONS, agent: null })).rejects.toBeInstanceOf(
      DefinitionsProjectError,
    );
  });

  it('refuses an unknown project, and an id that is not a UUID', async () => {
    await expect(set.execute({ projectId: UNKNOWN, agent: null })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(set.execute({ projectId: 'not-a-uuid', agent: null })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});
