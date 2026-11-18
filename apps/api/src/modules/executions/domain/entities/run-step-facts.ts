import type { RunQuestion } from '../value-objects/run-question.js';
import type { RunStepKind } from '../value-objects/run-step-kind.js';

/** One reported Run step: its kind and the structured result, as validated JSON. */
export interface RunStepRecord {
  kind: RunStepKind;
  result: unknown;
  /** The next number when absent. */
  index?: number;
  /** A `needs_input` step's question, stored as the Run's next message. */
  question?: RunQuestion;
  sessionRef?: string;
}

/** What storing a reported Run step did. */
export type RunStepOutcome =
  /** Stored now, or (`duplicate`) already stored by an earlier delivery of the same report. */
  | { status: 'stored'; index: number; duplicate?: boolean }
  /** The step would exceed the Run's `maxSteps`: it was not stored, and the Run is now `failed`. */
  | { status: 'step_limit' };
