import { describe, expect, it } from 'vitest';
import { defaultAgentOf } from '../../repositories/__tests__/in-memory-run-repository.js';
import { Task } from '../../value-objects/task.js';
import { Run } from '../run.js';
import { runData } from './run-fixtures.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
const START = {
  id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex' as const,
  agent: defaultAgentOf('codex'),
  task: Task.of('Add a health check'),
  startCommit: 'a'.repeat(40),
  remoteUrl: 'https://git.example.test/a.git',
  integrationBranch: 'dev',
  limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 10 },
  now: AT,
};

describe('the Phases of a Run', () => {
  it('are one Phase with the agent of the Run when it starts', () => {
    const run = Run.start(START);

    expect(run.phases).toEqual([
      {
        position: 0,
        itemId: null,
        kind: 'work',
        state: 'pending',
        agent: START.agent,
        sessionRef: null,
        summary: null,
        checkpointComment: null,
        stepsUsed: 0,
      },
    ]);
  });

  it('count the Run steps taken so far in the only Phase', () => {
    const run = Run.restore(runData({ stepCount: 4 }));

    expect(run.phases.map((phase) => phase.stepsUsed)).toEqual([4]);
  });

  it('are restored as stored, the current agent being the one at the current position', () => {
    const first = { position: 0, agent: defaultAgentOf('codex'), stepsUsed: 2 };
    const second = {
      position: 1,
      agent: { ...defaultAgentOf('codex'), name: 'next' },
      stepsUsed: 1,
    };
    const workflow = {
      name: 'flow',
      commit: 'c'.repeat(40),
      items: [
        { id: 'one', kind: 'work' as const, agent: 'default-codex' },
        { id: 'two', kind: 'work' as const, agent: 'next' },
      ],
    };
    const run = Run.restore(
      runData({
        stepCount: 3,
        workflow,
        phases: [
          { ...first, itemId: 'one' },
          { ...second, itemId: 'two' },
        ],
        currentPhase: 1,
        agent: second.agent,
      }),
    );

    expect(run.phases.map((phase) => [phase.position, phase.agent.name, phase.stepsUsed])).toEqual([
      [0, 'default-codex', 2],
      [1, 'next', 1],
    ]);
    expect(run.agent.name).toBe('next');
  });

  it('refuse a list that is empty, out of order or has another agent at the current position', () => {
    const agent = defaultAgentOf('codex');
    expect(() => Run.restore(runData({ phases: [] }))).toThrow(TypeError);
    expect(() => Run.restore(runData({ phases: [{ position: 1, agent, stepsUsed: 0 }] }))).toThrow(
      TypeError,
    );
    expect(() =>
      Run.restore(
        runData({ phases: [{ position: 0, agent: { ...agent, name: 'other' }, stepsUsed: 0 }] }),
      ),
    ).toThrow(TypeError);
  });

  it('are not changed by an operation on the Run', () => {
    const run = Run.restore(runData({ stepCount: 1 }));

    run.cancel(AT);

    expect(Object.keys(run.pendingChanges().fields)).not.toContain('phases');
    expect(run.phases).toHaveLength(1);
  });
});
