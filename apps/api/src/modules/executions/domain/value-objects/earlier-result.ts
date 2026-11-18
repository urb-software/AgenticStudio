import { RunCancellation } from './run-cancellation.js';
import type { RunLifecycleStored } from './run-lifecycle.js';
import type { RunPartEnd } from './run-part-end.js';

/** The result a `part_end` recorded, given back when a Follow-up reopens the Run. */
export class EarlierResult {
  private constructor(private readonly end: RunPartEnd) {}

  static of(end: RunPartEnd): EarlierResult {
    return new EarlierResult(end);
  }

  /** The cancel's author is told from its reason, which only the cancellation's wording fixes. */
  toStored(): Pick<RunLifecycleStored, 'state' | 'failure' | 'cancellation'> {
    const end = this.end;
    return {
      state: end.state,
      failure:
        end.state === 'failed' && end.failureCode
          ? { code: end.failureCode, detail: end.detail }
          : null,
      cancellation:
        end.state === 'cancelled'
          ? {
              by: end.detail.startsWith(RunCancellation.OPERATOR_PREFIX) ? 'operator' : 'system',
              reason: end.detail,
            }
          : null,
    };
  }
}
