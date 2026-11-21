import { MERGE_METHODS as CONTRACT_MERGE_METHODS } from '@agentic-studio/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectNotFoundError } from '../../../../domain/errors/project-errors.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { MERGE_METHODS } from '../../../../domain/value-objects/merge-method.js';
import { GetRunMergeMethodHandler } from '../../get-run-merge-method/handler.js';
import { SetMergeMethodHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const UNKNOWN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('merge method handlers', () => {
  let projects: InMemoryProjectRepository;
  let set: SetMergeMethodHandler;
  let read: GetRunMergeMethodHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    set = new SetMergeMethodHandler(projects);
    read = new GetRunMergeMethodHandler(projects);
  });

  // The domain may not import the contract package, so the list is pinned to the contract's here.
  it('lists the methods of the contract', () => {
    expect([...MERGE_METHODS]).toEqual([...CONTRACT_MERGE_METHODS]);
  });

  it('starts a project on squash', async () => {
    await expect(read.execute({ projectId: PROJECT })).resolves.toBe('squash');
  });

  it('changes the method and answers the project, and the run side reads the new value', async () => {
    const changed = await set.execute({ projectId: PROJECT, mergeMethod: 'merge_commit' });

    expect(changed).toMatchObject({ id: PROJECT, name: 'Shop', mergeMethod: 'merge_commit' });
    await expect(read.execute({ projectId: PROJECT })).resolves.toBe('merge_commit');
    await set.execute({ projectId: PROJECT, mergeMethod: 'squash' });
    await expect(read.execute({ projectId: PROJECT })).resolves.toBe('squash');
  });

  it('refuses an unknown project, and an id that is not a UUID, on both sides', async () => {
    await expect(set.execute({ projectId: UNKNOWN, mergeMethod: 'squash' })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(
      set.execute({ projectId: 'not-a-uuid', mergeMethod: 'squash' }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(read.execute({ projectId: UNKNOWN })).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('refuses a value outside the list and changes nothing', async () => {
    await expect(
      set.execute({ projectId: PROJECT, mergeMethod: 'rebase' as 'squash' }),
    ).rejects.toThrow('unknown');
    await expect(read.execute({ projectId: PROJECT })).resolves.toBe('squash');
  });
});
