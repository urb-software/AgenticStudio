import type {
  CONTROLLER_REPORTABLE_FAILURE_CODES,
  PreviewRefusal,
} from '@agentic-studio/contracts';

export type FailureCode = (typeof CONTROLLER_REPORTABLE_FAILURE_CODES)[number];

/** An operation failed for a reason the controller reports with a fixed code. */
export class OperationFailure extends Error {
  /** Set when the rollback after `up` removed the Project's running Preview. */
  previewRemoved = false;

  constructor(
    readonly code: FailureCode,
    detail: string,
    readonly refusals?: PreviewRefusal[],
  ) {
    super(detail);
    this.name = 'OperationFailure';
  }
}

/** A process or wait was interrupted because the operation was aborted (see the abort reason). */
export class OperationAborted extends Error {
  /** Set when the rollback after `up` removed the Project's running Preview. */
  previewRemoved = false;

  constructor() {
    super('The operation was aborted.');
    this.name = 'OperationAborted';
  }
}

/** Why an operation is aborted from outside. */
export type AbortReason = 'timeout' | 'lost' | 'shutdown';
