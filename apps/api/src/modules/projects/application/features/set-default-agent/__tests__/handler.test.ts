import { AGENT_NAME_PATTERN } from '@agentic-studio/agent-definitions';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DefinitionsProjectError,
  ProjectNotFoundError,
} from '../../../../domain/errors/project-errors.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { AgentName, InvalidAgentNameError } from '../../../../domain/value-objects/agent-name.js';
import { GetProjectDefaultAgentHandler } from '../../get-project-default-agent/handler.js';
import { SetDefaultAgentHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';
const UNKNOWN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('default agent handlers', () => {
  let projects: InMemoryProjectRepository;
  let set: SetDefaultAgentHandler;
  let read: GetProjectDefaultAgentHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    set = new SetDefaultAgentHandler(projects);
    read = new GetProjectDefaultAgentHandler(projects);
  });

  it('pins the name syntax to the one of the agent definitions', () => {
    expect(AgentName.PATTERN.source).toBe(AGENT_NAME_PATTERN.source);
  });

  it('names no default agent at first', async () => {
    await expect(read.execute({ projectId: PROJECT })).resolves.toEqual({
      status: 'found',
      agent: null,
    });
  });

  it('stores the name, answers the project and lets the other side read it back', async () => {
    const changed = await set.execute({ projectId: PROJECT, agent: 'reviewer' });

    expect(changed).toMatchObject({ id: PROJECT, defaultAgent: 'reviewer', mergeMethod: 'squash' });
    await expect(read.execute({ projectId: PROJECT })).resolves.toEqual({
      status: 'found',
      agent: 'reviewer',
    });
  });

  it('judges the syntax only: a name that no agent has is stored', async () => {
    await expect(
      set.execute({ projectId: PROJECT, agent: 'no-such-agent' }),
    ).resolves.toMatchObject({ defaultAgent: 'no-such-agent' });
  });

  it('clears the default with null', async () => {
    await set.execute({ projectId: PROJECT, agent: 'reviewer' });

    await set.execute({ projectId: PROJECT, agent: null });

    await expect(read.execute({ projectId: PROJECT })).resolves.toEqual({
      status: 'found',
      agent: null,
    });
  });

  it.each(['', 'Reviewer', '-reviewer', 'a b', 'a'.repeat(65)])(
    'refuses the invalid name %j and keeps the stored one',
    async (agent) => {
      await set.execute({ projectId: PROJECT, agent: 'reviewer' });

      await expect(set.execute({ projectId: PROJECT, agent })).rejects.toBeInstanceOf(
        InvalidAgentNameError,
      );
      await expect(read.execute({ projectId: PROJECT })).resolves.toMatchObject({
        agent: 'reviewer',
      });
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
    await expect(read.execute({ projectId: UNKNOWN })).resolves.toEqual({
      status: 'project_not_found',
    });
    await expect(read.execute({ projectId: 'not-a-uuid' })).resolves.toEqual({
      status: 'project_not_found',
    });
  });
});
