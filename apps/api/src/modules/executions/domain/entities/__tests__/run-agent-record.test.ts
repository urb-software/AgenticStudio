import { describe, expect, it } from 'vitest';
import { defaultAgentOf } from '../../repositories/__tests__/in-memory-run-repository.js';
import { Task } from '../../value-objects/task.js';
import { Run } from '../run.js';
import { runData } from './run-fixtures.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
const REVIEWER = {
  name: 'reviewer',
  source: 'definitions' as const,
  commit: 'c'.repeat(40),
  provider: 'claude_code' as const,
  model: 'opus',
  instructions: 'Review carefully.',
  skills: [] as string[],
};
const START = {
  id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  task: Task.of('Add a health check'),
  startCommit: 'a'.repeat(40),
  remoteUrl: 'https://git.example.test/a.git',
  integrationBranch: 'dev',
  limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 10 },
  now: AT,
};

describe('the agent of a Run', () => {
  it('is recorded at start, with the Provider of the Run the one of its agent', () => {
    const run = Run.start({ ...START, provider: 'claude_code', agent: REVIEWER });

    expect(run.agent.toData()).toEqual(REVIEWER);
    expect(run.provider).toBe('claude_code');
    expect(run.pendingChanges().fields).toEqual({});
  });

  it('refuses an agent of another Provider than the Run, at start and on restore', () => {
    expect(() => Run.start({ ...START, provider: 'codex', agent: REVIEWER })).toThrow(TypeError);
    expect(() => Run.restore(runData({ provider: 'codex', agent: REVIEWER }))).toThrow(TypeError);
  });

  it('refuses an agent record that disagrees with itself', () => {
    expect(() =>
      Run.start({ ...START, provider: 'claude_code', agent: { ...REVIEWER, commit: null } }),
    ).toThrow(TypeError);
  });

  it('never changes: no operation puts it among the pending changes', () => {
    const run = Run.restore(runData({ provider: 'claude_code', agent: REVIEWER }));

    run.cancel(AT);

    expect(Object.keys(run.pendingChanges().fields)).not.toContain('agent');
    expect(run.agent.toData()).toEqual(REVIEWER);
  });

  it('is the built-in Default agent of its Provider for a Run that recorded that', () => {
    const run = Run.start({ ...START, provider: 'codex', agent: defaultAgentOf('codex') });

    expect(run.agent).toMatchObject({
      name: 'default-codex',
      source: 'built_in',
      commit: null,
      model: 'default',
      instructions: '',
      skills: [] as string[],
    });
  });
});
