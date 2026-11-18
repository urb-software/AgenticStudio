import type { RunFailureCode } from './run-failure-code.js';

/** Why a Run failed: a code and a short explanation, never a secret. */
export class RunFailure {
  /** The contract's limit for the detail: the worker protocol is pinned to it by a test. */
  static readonly DETAIL_MAX_LENGTH = 2000;

  private constructor(
    readonly code: RunFailureCode,
    readonly detail: string,
  ) {}

  /** A failure reported from outside: the detail is cut to its limit. */
  static of(code: RunFailureCode, detail: string): RunFailure {
    return new RunFailure(code, detail.slice(0, RunFailure.DETAIL_MAX_LENGTH));
  }

  /** A failure Studio words itself, or one as storage holds it: the detail is kept as it is. */
  static restore(stored: { code: RunFailureCode; detail: string }): RunFailure {
    return new RunFailure(stored.code, stored.detail);
  }
}
