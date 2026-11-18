import type { RunLimits } from './run-limits.js';
import type { RunState } from './run-state.js';

export interface RunSweepFacts {
  state: RunState;
  claimedBy: string | null;
  heartbeatAt: Date | null;
  stepStartedAt: Date | null;
  waitingSince: Date | null;
  limits: RunLimits;
  deliveryRequested: boolean;
  sessionRef: string | null;
}
