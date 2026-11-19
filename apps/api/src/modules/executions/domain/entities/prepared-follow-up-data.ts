import type { FollowUpSource } from '../value-objects/follow-up-source.js';
import type { PreparedFollowUpItem } from '../value-objects/prepared-follow-up-item.js';

/** A prepared Follow-up's current values. */
export interface PreparedFollowUpData {
  readonly source: FollowUpSource;
  readonly text: string;
  readonly items: readonly PreparedFollowUpItem[];
}
