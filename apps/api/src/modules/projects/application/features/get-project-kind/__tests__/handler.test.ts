import { describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { GetProjectKindHandler } from '../handler.js';

const CODE = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';

describe('GetProjectKindHandler', () => {
  const projects = new InMemoryProjectRepository();
  projects.addProject(CODE, 'Shop');
  projects.addProject(DEFINITIONS, 'Agents', 'definitions');
  const handler = new GetProjectKindHandler(projects);

  it('answers the kind of an ordinary Project and of the definitions Project', async () => {
    await expect(handler.execute({ projectId: CODE })).resolves.toBe('code');
    await expect(handler.execute({ projectId: DEFINITIONS })).resolves.toBe('definitions');
  });

  it('answers null for an unknown id and for one that is not a UUID', async () => {
    await expect(
      handler.execute({ projectId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }),
    ).resolves.toBeNull();
    await expect(handler.execute({ projectId: 'not-a-uuid' })).resolves.toBeNull();
  });
});
