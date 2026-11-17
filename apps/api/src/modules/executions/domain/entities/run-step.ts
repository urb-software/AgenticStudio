/** Which part of the Run a step belongs to: its first, or a resume of the agent session. */
export type RunStepKind = 'start' | 'resume';

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

/**
 * One reported Run step (Issue #96): a child entity of the Run. It has an identity only within its
 * Run (its number), and only the Run creates one ({@link Run.reportStep}), after checking the
 * number against the steps it has taken and the step limit against its allowance, both from the
 * Run's own `stepCount`: the other steps of the Run are never loaded for that. Steps are stored in
 * their own table, listed by number on request and counted with every Run that is loaded.
 *
 * It cannot be built in an invalid state: only {@link RunStep.create} and {@link RunStep.restore}
 * make one.
 */
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
