import { CLAIMED_RUN_STATES, type RunState } from './run-state.js';

/** What the rule reads of a Run: its state and the worker that holds it. */
export interface LogAppendFacts {
  state: RunState;
  claimedBy: string | null;
}

/**
 * The log append rule (Issue #99): an agent worker may append events to a Run's log only while it
 * holds the Run, that is the Run is `preparing` or `running` and `claimed_by` is that worker.
 *
 * The store appends in one atomic step under the Run's row lock, with the states this rule
 * supplies in its statement (the duplicate filter and the cap see the same locked state);
 * {@link LogAppendRule.allows} is the same rule over a Run, which a test uses to prove the
 * statement follows it.
 */
export class LogAppendRule {
  /** The states in which a holding worker may append. */
  static readonly STATES = CLAIMED_RUN_STATES;

  /** Whether `workerId` may append to the log of this Run now. */
  static allows(run: LogAppendFacts, workerId: string): boolean {
    return (
      (LogAppendRule.STATES as readonly string[]).includes(run.state) && run.claimedBy === workerId
    );
  }
}
