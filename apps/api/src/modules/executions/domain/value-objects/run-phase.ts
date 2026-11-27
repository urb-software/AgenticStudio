import type { RunAgentData } from './run-agent.js';
import type { RunPhaseFinding } from './run-phase-finding.js';

export const RUN_PHASE_KINDS = ['work', 'review'] as const;
export type RunPhaseKind = (typeof RUN_PHASE_KINDS)[number];

export const RUN_PHASE_STATES = ['pending', 'running', 'done', 'failed'] as const;
export type RunPhaseState = (typeof RUN_PHASE_STATES)[number];

export const RUN_PHASE_VERDICTS = ['approved', 'changes_requested'] as const;
export type RunPhaseVerdict = (typeof RUN_PHASE_VERDICTS)[number];

/** One ordered part of a Run with an agent: its place in the Run and the Run steps it took. */
export interface RunPhaseData {
  /** 0 for the first Phase, then 1, 2, … without gaps. */
  position: number;
  /** The Workflow item the Phase came from; `null` for the one Phase of a Run with an agent. */
  itemId?: string | null;
  kind?: RunPhaseKind;
  state?: RunPhaseState;
  agent: RunAgentData;
  /** The agent session of the Phase; `null` until a Run step reports one. Internal. */
  sessionRef?: string | null;
  /** What the Phase's last Run step reported as its summary (redacted); `null` before one. */
  summary?: string | null;
  /** A review Phase's Verdict; `null` until it has one, and always for a work Phase. */
  verdict?: RunPhaseVerdict | null;
  /** What the review found (redacted); empty without a Verdict and for `approved` with none. */
  findings?: readonly RunPhaseFinding[];
  /** What the operator wrote at the Checkpoint before the Phase: untrusted; `null` for none. */
  checkpointComment?: string | null;
  stepsUsed: number;
}
