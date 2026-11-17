import type { FollowUpSource } from '../entities/run.js';

/** One part of a prepared Follow-up the operator can leave out (Issue #145). */
export interface PreparedFollowUpItem {
  name: string;
  url: string;
  logAvailable: boolean;
  /** Exactly the part of the text that belongs to this item. */
  section: string;
}

/**
 * The Follow-up Studio prepared for the operator to review (Issue #145): never sent by itself.
 * One per Run; a new preparation replaces it.
 */
export interface PreparedFollowUp {
  source: FollowUpSource;
  text: string;
  items: PreparedFollowUpItem[];
}
