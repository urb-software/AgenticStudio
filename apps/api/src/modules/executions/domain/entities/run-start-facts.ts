import type { Provider } from '../value-objects/provider.js';
import type { RunLimits } from '../value-objects/run-limits.js';
import type { Task } from '../value-objects/task.js';

/** What a new Run is started from (Issue #96). */
export interface RunStartInput {
  id: string;
  projectId: string;
  provider: Provider;
  task: Task;
  startCommit: string;
  remoteUrl: string;
  integrationBranch: string;
  /** The limits in force when the Run is started (Issue #100). */
  limits: RunLimits;
  /**
   * The Run's creation and first activity as the object sees them. The store does not take them:
   * it assigns `created_at` itself, so the queue order (creation time, then id) uses one clock
   * (Issue #169), and the Run it returns carries the stored time.
   */
  now: Date;
}
