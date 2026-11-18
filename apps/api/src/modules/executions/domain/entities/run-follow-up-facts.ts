import type { FollowUpComments, FollowUpSource } from '../value-objects/follow-up.js';

/**
 * Where a Follow-up's text came from, when it was prepared (Issue #145, #147, #146): the source, and
 * for `review_comments` what the operator's selection came to in the Run's loaded Review comments,
 * as values the handler read under the Run's lock (how many, and whose); `null` when the selected
 * comments are not all in the loaded set.
 */
export type FollowUpOrigin =
  | Exclude<FollowUpSource, 'review_comments'>
  | { source: 'review_comments'; comments: FollowUpComments | null };

/**
 * What a Follow-up used up beyond the Run: the prepared Follow-up of its source (Issue #145), or the
 * loaded Review comments it was prepared from (Issue #146). The caller removes it in the same
 * transaction that saves the Run.
 */
export type FollowUpConsumption = Exclude<FollowUpSource, 'bring_up_to_date'>;
