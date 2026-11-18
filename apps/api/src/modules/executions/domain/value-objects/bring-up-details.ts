/**
 * For a bring-up-to-date request the Follow-up's text is the operator's optional note (empty when
 * there is none).
 */
export interface BringUpDetails {
  mergedCommit?: string;
  updateBase?: string;
  updateTip?: string;
}
