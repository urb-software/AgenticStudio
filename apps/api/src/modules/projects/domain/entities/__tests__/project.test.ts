import { describe, expect, it } from 'vitest';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import { Project } from '../project.js';

const STORED: RestoreData<typeof Project> = {
  id: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  name: 'Shop',
  createdAt: new Date('2026-11-13T10:00:00.000Z'),
};

describe('Project', () => {
  it('is restored from what the store holds and exposes its values', () => {
    const project = Project.restore(STORED);

    expect(project).toMatchObject(STORED);
  });
});
