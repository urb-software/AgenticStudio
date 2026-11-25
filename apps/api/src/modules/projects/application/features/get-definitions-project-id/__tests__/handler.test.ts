import { describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { GetDefinitionsProjectIdHandler } from '../handler.js';

const CODE = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';

describe('GetDefinitionsProjectIdHandler', () => {
  it('answers null while only ordinary Projects exist', async () => {
    const projects = new InMemoryProjectRepository();
    projects.addProject(CODE, 'Shop');

    await expect(new GetDefinitionsProjectIdHandler(projects).execute()).resolves.toBeNull();
  });

  it('answers the id of the definitions Project', async () => {
    const projects = new InMemoryProjectRepository();
    projects.addProject(CODE, 'Shop');
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');

    await expect(new GetDefinitionsProjectIdHandler(projects).execute()).resolves.toBe(DEFINITIONS);
  });
});
