import { CLAIMED_RUN_STATES } from './run-state.js';
import type { LogAppendFacts } from './log-append-facts.js';

/**
 * The store appends in one atomic step under the Run's row lock, so the duplicate filter and the
 * cap see the same locked state; `allows` is the same rule, which a test uses to prove the
 * statement follows it.
 */
export class LogAppendRule {
  static readonly STATES = CLAIMED_RUN_STATES;

  static allows(run: LogAppendFacts, workerId: string): boolean {
    return (
      (LogAppendRule.STATES as readonly string[]).includes(run.state) && run.claimedBy === workerId
    );
  }
}
