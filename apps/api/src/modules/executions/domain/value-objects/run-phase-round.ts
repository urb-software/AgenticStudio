import type { RunPhaseFinding } from './run-phase-finding.js';
import type { RunPhaseVerdict } from './run-phase-verdict.js';

/** What one round of a Phase ended with, kept when a send-back runs the Phase again. */
export interface RunPhaseRound {
  /** 1 for the first time the Phase ran, then 2, 3, � */
  round: number;
  summary: string | null;
  verdict: RunPhaseVerdict | null;
  findings: readonly RunPhaseFinding[];
}
