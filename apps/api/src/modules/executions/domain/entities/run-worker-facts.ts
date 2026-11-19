import type { WorkerStatusData } from '../value-objects/worker-status-data.js';

/** What the Run's handler fetched about the agent workers, as values. */
export interface WorkerFacts {
  /** The last report of the Run's last claimer; `undefined`: none, or the Run was never claimed. */
  holderLastSeen: Date | undefined;
  /** The latest report of any agent worker; `undefined`: none. */
  latest: WorkerStatusData | undefined;
}

/** What the Run needs to know about the agent worker to take a Follow-up. */
export interface FollowUpFacts {
  /** The agent worker that holds the Run's Working copy reported within the lease. */
  workerAvailable: boolean;
  /** The Run's Provider is available on the connected agent worker. */
  providerAvailable: boolean;
}
