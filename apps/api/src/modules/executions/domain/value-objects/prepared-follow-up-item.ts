/** One part of a prepared Follow-up the operator can leave out (Issue #145). */
export interface PreparedFollowUpItem {
  name: string;
  url: string;
  logAvailable: boolean;
  /** Exactly the part of the text that belongs to this item. */
  section: string;
}
