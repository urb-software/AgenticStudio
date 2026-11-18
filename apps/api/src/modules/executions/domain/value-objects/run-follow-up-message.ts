import type { FollowUpSource } from './follow-up-source.js';
import type { FollowUpComments } from './follow-up-comments.js';
import type { BringUpDetails } from './bring-up-details.js';

export type RunFollowUpMessage = {
  kind: 'follow_up';
  text: string;
  at: Date;
  source?: FollowUpSource;
  sourceComments?: FollowUpComments;
} & BringUpDetails;
