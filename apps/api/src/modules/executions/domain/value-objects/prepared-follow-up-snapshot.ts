import type { FollowUpSource } from './follow-up.js';
import type { PreparedFollowUpItem } from './prepared-follow-up-item.js';

/** A prepared Follow-up's current values as read-only plain data (rule 10). */
export interface PreparedFollowUpSnapshot {
  readonly source: FollowUpSource;
  readonly text: string;
  readonly items: readonly PreparedFollowUpItem[];
}
