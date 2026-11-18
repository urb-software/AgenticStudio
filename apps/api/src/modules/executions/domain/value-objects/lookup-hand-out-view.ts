import type { LookupStatus } from './lookup-status.js';

export interface LookupHandOutView {
  id: string;
  runId: string;
  status: LookupStatus;
  requestedAt: Date;
  claimedAt: Date | null;
  retryAt: Date | null;
}
