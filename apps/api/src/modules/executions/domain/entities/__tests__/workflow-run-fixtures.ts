import { defaultAgentOf } from '../../repositories/__tests__/in-memory-run-repository.js';
import type { RunAgentData } from '../../value-objects/run-agent.js';
import type { RunWorkflowData } from '../../value-objects/run-workflow.js';
import { Task } from '../../value-objects/task.js';
import { Run } from '../run.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
export const WORKFLOW_COMMIT = 'c'.repeat(40);

/** A definitions agent of the given Provider, as a Phase records it. */
export function phaseAgent(
  name: string,
  provider: 'codex' | 'claude_code' = 'codex',
): RunAgentData {
  return { ...defaultAgentOf(provider), name, source: 'definitions', commit: WORKFLOW_COMMIT };
}

export const WORKFLOW_RECORD: RunWorkflowData = {
  name: 'build-and-polish',
  commit: WORKFLOW_COMMIT,
  items: [
    { id: 'build', kind: 'work', agent: 'builder' },
    { id: 'polish', kind: 'work', agent: 'polisher' },
    { id: 'finish', kind: 'work', agent: 'finisher' },
  ],
};

/** A Run of three work Phases: Codex, then Claude Code, then Codex. */
export function workflowRun(maxSteps = 3, maxTotalSteps = 20): Run {
  const builder = phaseAgent('builder');
  return Run.start({
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: builder.provider,
    agent: builder,
    workflow: {
      record: WORKFLOW_RECORD,
      phaseAgents: [builder, phaseAgent('polisher', 'claude_code'), phaseAgent('finisher')],
    },
    task: Task.of('Add a health check'),
    startCommit: 'a'.repeat(40),
    remoteUrl: 'https://git.example.test/a.git',
    integrationBranch: 'dev',
    limits: { stepMinutes: 60, maxSteps, waitingDays: 14, maxTotalSteps },
    now: AT,
  });
}
