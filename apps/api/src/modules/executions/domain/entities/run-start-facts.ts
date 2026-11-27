import type { Provider } from '../value-objects/provider.js';
import type { RunAgentData } from '../value-objects/run-agent.js';
import type { RunLimits } from '../value-objects/run-limits.js';
import type { RunWorkflowData } from '../value-objects/run-workflow.js';
import type { Task } from '../value-objects/task.js';

export interface RunStartInput {
  id: string;
  projectId: string;
  provider: Provider;
  /** The agent of the first Phase when `workflow` is set. */
  agent: RunAgentData;
  /** A Run of a Workflow: what it recorded, and the agent of each Phase in order. */
  workflow?: { record: RunWorkflowData; phaseAgents: readonly RunAgentData[] };
  task: Task;
  startCommit: string;
  remoteUrl: string;
  integrationBranch: string;
  limits: RunLimits;
  /**
   * The store assigns `created_at` itself, so the queue order uses one clock; this
   * time is not stored.
   */
  now: Date;
}
