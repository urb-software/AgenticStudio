import type { RunState } from './run-state.js';

export interface LogAppendFacts {
  state: RunState;
  claimedBy: string | null;
}
