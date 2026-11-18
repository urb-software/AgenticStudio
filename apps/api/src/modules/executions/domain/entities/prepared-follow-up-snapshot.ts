import type { FollowUpSource } from '../value-objects/follow-up.js';
import type { PreparedFollowUpItem } from '../value-objects/prepared-follow-up-item.js';

/** A prepared Follow-up's current values. */
export interface PreparedFollowUpSnapshot {
  readonly source: FollowUpSource;
  readonly text: string;
  readonly items: readonly PreparedFollowUpItem[];
}
