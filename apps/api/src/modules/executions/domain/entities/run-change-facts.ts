import type { RunStep } from './run-step.js';
import type { BringUpDetails } from '../value-objects/bring-up-details.js';
import type { RunDeliveryData } from '../value-objects/run-delivery.js';
import type { RunLifecycleData } from '../value-objects/run-lifecycle.js';
import type { RunMessage } from '../value-objects/run-message.js';
import type { RunProgressData } from '../value-objects/run-progress.js';
import type { RunPullRequestStatusData } from '../value-objects/run-pull-request-status-data.js';
import type { RunWorkerClaimData } from '../value-objects/run-worker-claim.js';
import type { RunWorkingCopy } from '../value-objects/run-working-copy.js';

/** The fields of a Run that can change after it started. */
export type RunFieldChanges = Partial<
  RunLifecycleData &
    RunDeliveryData &
    RunWorkerClaimData &
    RunProgressData & {
      workingCopy: RunWorkingCopy | null;
      failingChecks: readonly string[];
      pullRequestStatus: RunPullRequestStatusData;
    }
>;

/** What changed on a Run since it was started or restored, for the store to save in one step. */
export interface RunChanges {
  fields: RunFieldChanges;
  messages: RunMessage[];
  steps?: RunStep[];
  followUpEntry?: BringUpDetails;
  environmentFileSecretRef?: string | null;
}
