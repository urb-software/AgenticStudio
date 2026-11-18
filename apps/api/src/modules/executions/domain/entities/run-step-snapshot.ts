import type { RunStepKind } from '../value-objects/run-step-kind.js';

/** A Run step's current values as read-only plain data (rule 10); {@link RunStep.snapshot}. */
export interface RunStepSnapshot {
  /** The step's number within its Run, from 1, in report order. */
  readonly index: number;
  readonly kind: RunStepKind;
  /** The structured result, as validated JSON (redacted before it is stored). */
  readonly result: unknown;
  /** When the store recorded it; absent for a step the Run has just created. */
  readonly reportedAt?: Date;
}
