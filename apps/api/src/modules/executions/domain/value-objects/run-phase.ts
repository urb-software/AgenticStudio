import type { RunAgentData } from './run-agent.js';

/** One ordered part of a Run with an agent: its place in the Run and the Run steps it took. */
export interface RunPhaseData {
  /** 0 for the first Phase, then 1, 2, … without gaps. */
  position: number;
  agent: RunAgentData;
  stepsUsed: number;
}
