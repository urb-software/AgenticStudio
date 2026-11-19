import type { RunStepKind } from '../value-objects/run-step-kind.js';

/** What a Run step is restored from. */
export interface RunStepData {
  /** The step's number within its Run, from 1, in report order. */
  readonly index: number;
  readonly kind: RunStepKind;
  /** The structured result, as validated JSON (redacted before it is stored). */
  readonly result: unknown;
}
