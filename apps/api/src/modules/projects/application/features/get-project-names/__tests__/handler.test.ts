import { describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { GetProjectNamesHandler } from '../handler.js';

const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const UNKNOWN = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';

describe('GetProjectNamesHandler', () => {
  it('answers the names by id and leaves an unknown id out', async () => {
    const projects = new InMemoryProjectRepository();
    projects.addProject(A, 'Shop');
    projects.addProject(B, 'Blog');

    const names = await new GetProjectNamesHandler(projects).execute({ ids: [A, B, UNKNOWN] });

    expect(Object.fromEntries(names)).toEqual({ [A]: 'Shop', [B]: 'Blog' });
  });

  it('answers nothing for no ids', async () => {
    const names = await new GetProjectNamesHandler(new InMemoryProjectRepository()).execute({
      ids: [],
    });

    expect(names.size).toBe(0);
  });
});
