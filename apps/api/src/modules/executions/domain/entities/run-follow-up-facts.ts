import type { FollowUpComments, FollowUpSource } from '../value-objects/follow-up.js';

/**
 * Where a Follow-up's text came from; `comments` is `null` when the selection is not all in the
 * loaded set.
 */
export type FollowUpOrigin =
  | Exclude<FollowUpSource, 'review_comments'>
  | { source: 'review_comments'; comments: FollowUpComments | null };

/**
 * What a Follow-up used up beyond the Run; the caller removes it in the transaction
 * that saves the Run.
 */
export type FollowUpConsumption = Exclude<FollowUpSource, 'bring_up_to_date'>;
