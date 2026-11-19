import type { Provider } from '../value-objects/provider.js';
import type { RunConversationData } from '../value-objects/run-conversation.js';
import type { RunDeliveryData } from '../value-objects/run-delivery.js';
import type { RunLifecycleData } from '../value-objects/run-lifecycle.js';
import type { RunProgressData } from '../value-objects/run-progress.js';
import type { RunPullRequestStatusData } from '../value-objects/run-pull-request-status-data.js';
import type { RunWorkerClaimData } from '../value-objects/run-worker-claim.js';
import type { RunWorkingCopy } from '../value-objects/run-working-copy.js';

/** What a Run is restored from: the flat record that storage holds. */
export interface RunData
  extends
    RunLifecycleData,
    RunDeliveryData,
    RunWorkerClaimData,
    RunProgressData,
    RunConversationData {
  id: string;
  projectId: string;
  provider: Provider;
  task: string;
  startCommit: string;
  /** Never a credential. */
  remoteUrl: string;
  createdAt: Date;
  workingCopy: RunWorkingCopy | null;
  failingChecks: readonly string[];
  pullRequestStatus: RunPullRequestStatusData;
}
