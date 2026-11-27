import type { Provider } from '../value-objects/provider.js';
import type { RunAgentData } from '../value-objects/run-agent.js';
import type { RunConversationData } from '../value-objects/run-conversation.js';
import type { RunDeliveryData } from '../value-objects/run-delivery.js';
import type { RunPhaseData } from '../value-objects/run-phase.js';
import type { RunWorkflowData } from '../value-objects/run-workflow.js';
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
  /** Its provider equals `provider`. Set at start, never changed. */
  agent: RunAgentData;
  /**
   * All the Run's Phases in order; left out, the one Phase of `agent`. The Phase at `currentPhase`
   * has the agent `agent`, and its steps are counted from `stepCount`.
   */
  phases?: readonly RunPhaseData[];
  /** The position of the current Phase; 0 when left out. */
  currentPhase?: number;
  /** The Workflow the Run started with; absent or `null` for a Run started with an agent. */
  workflow?: RunWorkflowData | null;
  /** A Workflow Run whose next Phase has not been claimed yet. */
  phasePending?: boolean;
  /** The place, among the Workflow's items, of the Checkpoint the Run waits at; `null` for none. */
  checkpointItem?: number | null;
  /** The Workflow is over and the Run is queued only to deliver what exists. */
  workflowEnded?: boolean;
  task: string;
  startCommit: string;
  /** Never a credential. */
  remoteUrl: string;
  createdAt: Date;
  workingCopy: RunWorkingCopy | null;
  failingChecks: readonly string[];
  pullRequestStatus: RunPullRequestStatusData;
}
