import type { Provider } from './provider.js';
import type { RunConversationStored } from './run-conversation.js';
import type { RunDeliveryStored } from './run-delivery.js';
import type { RunLifecycleStored } from './run-lifecycle.js';
import type { RunProgressStored } from './run-progress.js';
import type { StoredPullRequestStatus } from './run-pull-request-status.js';
import type { RunWorkerClaimStored } from './run-worker-claim.js';
import type { RunWorkingCopy } from './run-working-copy.js';

/**
 * A Run's state as a plain, flat record: what storage holds and what a snapshot carries (the
 * stored shape, one field per column or group of columns, unchanged by the grouping into value
 * objects). The `Run` class is built from it with `Run.restore` and gives the same record back
 * with `Run.snapshot`; the concept each field belongs to documents it (`RunLifecycleStored`,
 * `RunDeliveryStored`, `RunWorkerClaimStored`, `RunProgressStored`, `StoredPullRequestStatus`,
 * `RunConversationStored`).
 */
export interface RunData
  extends
    RunLifecycleStored,
    RunDeliveryStored,
    RunWorkerClaimStored,
    RunProgressStored,
    RunConversationStored {
  id: string;
  projectId: string;
  provider: Provider;
  task: string;
  /** The integration branch's commit when the Run was started. */
  startCommit: string;
  /** The Repository's remote URL when the Run was started (Issue #98); never a credential. */
  remoteUrl: string;
  createdAt: Date;
  /** The latest reported Working copy state; `null` until the first Run step is reported. */
  workingCopy: RunWorkingCopy | null;
  /** Names of the checks the agent reported failed in the latest Run step. */
  failingChecks: string[];
  /** Where the Run's pull request stands on the Git host, as last read (Issue #142). */
  pullRequestStatus: StoredPullRequestStatus;
}
