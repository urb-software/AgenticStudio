import type { Provider } from '../value-objects/provider.js';
import type { RunLimits } from '../value-objects/run-limits.js';
import type { Task } from '../value-objects/task.js';

export interface RunStartInput {
  id: string;
  projectId: string;
  provider: Provider;
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
