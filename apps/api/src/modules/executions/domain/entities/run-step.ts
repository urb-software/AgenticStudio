import type { RunStepSnapshot } from './run-step-snapshot.js';
import type { RunStepKind } from '../value-objects/run-step-kind.js';

/** One reported Run step: only the Run creates one ({@link Run.reportStep}). */
export class RunStep {
  private constructor(
    readonly index: number,
    readonly kind: RunStepKind,
    readonly result: unknown,
    readonly reportedAt?: Date,
  ) {}

  /** A step the Run just took, not stored yet. */
  static create(input: { index: number; kind: RunStepKind; result: unknown }): RunStep {
    if (!Number.isInteger(input.index) || input.index < 1) {
      throw new TypeError(`A Run step's number starts at 1: ${input.index}`);
    }
    return new RunStep(input.index, input.kind, input.result);
  }

  /** A step as storage holds it. */
  static restore(data: RunStepSnapshot): RunStep {
    return new RunStep(data.index, data.kind, data.result, data.reportedAt);
  }

  snapshot(): RunStepSnapshot {
    return {
      index: this.index,
      kind: this.kind,
      result: this.result,
      ...(this.reportedAt === undefined ? {} : { reportedAt: this.reportedAt }),
    };
  }
}
