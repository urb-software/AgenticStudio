import type { RunState } from './run-state.js';

export interface HandOutView {
  id: string;
  projectId: string;
  state: RunState;
  claimedBy: string | null;
  sessionRef: string | null;
  /** A Workflow Run between two Phases: it keeps its place and its worker like an answered Run. */
  phasePending?: boolean;
  followUpQueued: boolean;
  deliveryRequested: boolean;
  lastClaimedBy: string | null;
  createdAt: Date;
}
