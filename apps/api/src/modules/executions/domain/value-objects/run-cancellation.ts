import type { RunCancelledBy } from './run-cancelled-by.js';

/** Who ended a Run on purpose and the reason it keeps. */
export class RunCancellation {
  static readonly OPERATOR_PREFIX = 'Cancelled by the operator';

  static readonly OPERATOR_BRANCH_PUSHED = new RunCancellation(
    'operator',
    'Cancelled by the operator during its delivery: the Run branch was pushed, no pull request was opened.',
  );

  static readonly OPERATOR = new RunCancellation('operator', `${RunCancellation.OPERATOR_PREFIX}.`);

  private constructor(
    readonly by: RunCancelledBy,
    readonly reason: string,
  ) {}

  /** The system cancelled a Run that waited for the operator longer than its limit. */
  static afterWaiting(days: number): RunCancellation {
    return new RunCancellation(
      'system',
      `Cancelled automatically: the run waited for the operator longer than ${days} ${days === 1 ? 'day' : 'days'}.`,
    );
  }

  /** A cancellation as storage holds it. */
  static restore(stored: { by: RunCancelledBy; reason: string }): RunCancellation {
    return new RunCancellation(stored.by, stored.reason);
  }
}
