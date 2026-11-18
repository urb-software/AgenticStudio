import type { RunQuestion } from '../value-objects/run-conversation.js';
import type { RunStepKind } from '../value-objects/run-step-kind.js';

/** One reported Run step: its kind and the structured result, as validated JSON. */
export interface RunStepRecord {
  kind: RunStepKind;
  result: unknown;
  /** The step's number as the worker reports it (review of #121); the next one when absent. */
  index?: number;
  /** A `needs_input` step's question (Issue #103): stored as the Run's next message. */
  question?: RunQuestion;
  /** The agent session the step reported (Issue #103): becomes the Run's session reference. */
  sessionRef?: string;
}

/** What storing a reported Run step did (Issue #100: the Run also enforces the step limit). */
export type RunStepOutcome =
  /** Stored now, or (`duplicate`) already stored by an earlier delivery of the same report. */
  | { status: 'stored'; index: number; duplicate?: boolean }
  /** The step would exceed the Run's `maxSteps`: it was not stored, and the Run is now `failed`. */
  | { status: 'step_limit' };
