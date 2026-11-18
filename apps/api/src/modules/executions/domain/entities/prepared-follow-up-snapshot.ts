import type { FollowUpSource } from '../value-objects/follow-up.js';
import type { PreparedFollowUpItem } from '../value-objects/prepared-follow-up-item.js';

/** A prepared Follow-up's current values as read-only plain data. */
export interface PreparedFollowUpSnapshot {
  readonly source: FollowUpSource;
  readonly text: string;
  readonly items: readonly PreparedFollowUpItem[];
}
