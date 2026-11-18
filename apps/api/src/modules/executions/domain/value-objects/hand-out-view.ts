import type { RunState } from './run-state.js';

export interface HandOutView {
  id: string;
  projectId: string;
  state: RunState;
  claimedBy: string | null;
  sessionRef: string | null;
  followUpQueued: boolean;
  deliveryRequested: boolean;
  lastClaimedBy: string | null;
  createdAt: Date;
}
