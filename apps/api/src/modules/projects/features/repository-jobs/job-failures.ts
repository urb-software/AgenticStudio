import type { JobFailure } from '../../../../platform/queue/job-queue.js';
import {
  gitOperationFailure,
  interruptedFailure,
  type RepositoryFailure,
  repositoryFailure,
  unexpectedFailure,
} from '../../domain/entities/repository.js';
import { GitOperationError } from '../../ports/repository-git.js';
import type { RepositoryOperation } from '../../ports/repository-jobs.js';
import { NO_TRUSTED_HOST_KEY_DETAIL, NoTrustedHostKeyError } from '../deploy-key/handler.js';

/**
 * How the Repository's job turns errors into stored failures, shared by its clone
 * (`clone-repository`) and fetch (`fetch-clone`) processors.
 */

/** The failure stored for a clone or fetch job that did not finish on its own. */
export function unfinishedJobFailure(
  operation: RepositoryOperation,
  failure: JobFailure,
): RepositoryFailure {
  switch (failure.reason) {
    case 'timeout':
      return repositoryFailure('timeout', `The ${operation} took too long and was stopped.`);
    case 'cancelled':
      return repositoryFailure('unknown', 'Cancelled');
    // A crash-like end: the queue lost the job, or the API is shutting down (#60 clarification 2).
    case 'stalled':
    case 'shutdown':
      return interruptedFailure();
    case 'error':
      return unexpectedFailure();
  }
}

/** Whether `error` is the abort of the job's signal; a processor rethrows it to the queue. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The failure of a Git step of the job, or `undefined` when `error` is not a Git failure (it
 * is then unexpected, and the queue reports it). No trusted host key is a `host_key_mismatch`
 * before Git runs (Issue #62); a Git failure keeps its reason and redacted output.
 */
export function gitStepFailure(error: unknown): RepositoryFailure | undefined {
  if (error instanceof NoTrustedHostKeyError) {
    return repositoryFailure('host_key_mismatch', NO_TRUSTED_HOST_KEY_DETAIL);
  }
  if (error instanceof GitOperationError) return gitOperationFailure(error.reason, error.detail);
  return undefined;
}
