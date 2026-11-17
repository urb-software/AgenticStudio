import { Injectable } from '@nestjs/common';
import { FollowUpRunHandler } from '../follow-up-run/handler.js';

/**
 * Command (Issue #147): the operator asks for a finished Run's branch to be brought up to date with
 * the integration branch. It is a Follow-up in every respect (the same eligibility, Run step
 * allowance, concurrency limits, agent session and Working copy), marked `bring_up_to_date`, so it
 * is the Follow-up handler with that source; the note is the Follow-up's text (empty when there is
 * none). The request does not look at how far behind the Run is: the pull request state may be
 * stale, so the agent worker decides, and says so when there was nothing to do. Throws what the
 * Follow-up handler throws.
 */
@Injectable()
export class BringUpToDateHandler {
  constructor(private readonly followUps: FollowUpRunHandler) {}

  execute(runId: string, note: string | undefined) {
    return this.followUps.execute(runId, note ?? '', 'bring_up_to_date');
  }
}
