import type {
  CONTROLLER_REPORTABLE_FAILURE_CODES,
  PreviewRefusal,
} from '@agentic-studio/contracts';

export type FailureCode = (typeof CONTROLLER_REPORTABLE_FAILURE_CODES)[number];

/** An operation failed for a reason the controller reports with a fixed code. */
export class OperationFailure extends Error {
  constructor(
    readonly code: FailureCode,
    detail: string,
    readonly refusals?: PreviewRefusal[],
    /** Whether the rollback after `up` removed the Project's running Preview. */
    readonly previewRemoved = false,
  ) {
    super(detail);
    this.name = 'OperationFailure';
  }

  /** The same failure, once the rollback after `up` has removed the Preview. */
  afterRollback(): OperationFailure {
    return new OperationFailure(this.code, this.message, this.refusals, true);
  }
}

/** A process or wait was interrupted because the operation was aborted (see the abort reason). */
export class OperationAborted extends Error {
  /** Whether the rollback after `up` removed the Project's running Preview. */
  constructor(readonly previewRemoved = false) {
    super('The operation was aborted.');
    this.name = 'OperationAborted';
  }

  /** The same abort, once the rollback after `up` has removed the Preview. */
  afterRollback(): OperationAborted {
    return new OperationAborted(true);
  }
}

/** Why an operation is aborted from outside. */
export type AbortReason = 'timeout' | 'lost' | 'shutdown';
