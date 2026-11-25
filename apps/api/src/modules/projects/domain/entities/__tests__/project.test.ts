import { describe, expect, it } from 'vitest';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import { DefinitionsProjectError } from '../../errors/project-errors.js';
import { AgentName } from '../../value-objects/agent-name.js';
import { Project } from '../project.js';

const STORED: RestoreData<typeof Project> = {
  id: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  name: 'Shop',
  mergeMethod: 'merge_commit',
  kind: 'definitions',
  defaultAgent: null,
  createdAt: new Date('2026-11-13T10:00:00.000Z'),
};

describe('Project', () => {
  it('is restored from what the store holds and exposes its values', () => {
    const project = Project.restore(STORED);

    expect(project).toMatchObject(STORED);
  });

  it('changes only its merge method, keeping the original untouched', () => {
    const project = Project.restore({ ...STORED, mergeMethod: 'squash' });

    const changed = project.withMergeMethod('merge_commit');

    expect(changed).toMatchObject({ ...STORED, mergeMethod: 'merge_commit' });
    expect(project.mergeMethod).toBe('squash');
    expect(changed.kind).toBe('definitions');
  });

  it('changes only its default agent, keeping the original untouched', () => {
    const project = Project.restore({ ...STORED, kind: 'code', defaultAgent: null });

    const changed = project.withDefaultAgent(AgentName.of('reviewer'));

    expect(changed).toMatchObject({ ...STORED, kind: 'code', defaultAgent: 'reviewer' });
    expect(project.defaultAgent).toBeNull();
    expect(changed.withDefaultAgent(null).defaultAgent).toBeNull();
  });

  it('accepts no default agent when it is the definitions Repository', () => {
    expect(() =>
      Project.restore({ ...STORED, kind: 'definitions' }).withDefaultAgent(AgentName.of('x')),
    ).toThrow(DefinitionsProjectError);
  });

  it('accepts an Environment file unless it is the definitions Repository', () => {
    expect(() =>
      Project.restore({ ...STORED, kind: 'code' }).assertAcceptsEnvironmentFile(),
    ).not.toThrow();
    expect(() =>
      Project.restore({ ...STORED, kind: 'definitions' }).assertAcceptsEnvironmentFile(),
    ).toThrow(DefinitionsProjectError);
  });
});
