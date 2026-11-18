import type { Provider } from '../value-objects/provider.js';
import type { RunConversationStored } from '../value-objects/run-conversation.js';
import type { RunDeliveryStored } from '../value-objects/run-delivery.js';
import type { RunLifecycleStored } from '../value-objects/run-lifecycle.js';
import type { RunProgressStored } from '../value-objects/run-progress.js';
import type { StoredPullRequestStatus } from '../value-objects/run-pull-request-status.js';
import type { RunWorkerClaimStored } from '../value-objects/run-worker-claim.js';
import type { RunWorkingCopy } from '../value-objects/run-working-copy.js';

/** A Run's state as the flat record that storage holds and a snapshot carries. */
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
  startCommit: string;
  /** Never a credential. */
  remoteUrl: string;
  createdAt: Date;
  workingCopy: RunWorkingCopy | null;
  failingChecks: string[];
  pullRequestStatus: StoredPullRequestStatus;
}
