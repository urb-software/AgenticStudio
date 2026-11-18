import type { RunStepSnapshot } from './run-step-snapshot.js';
import type { BringUpDetails, RunMessage } from '../value-objects/run-conversation.js';
import type { RunData } from './run-data.js';

/**
 * What changed on a Run since it was started or restored, for the store to save in one step
 * (Issue #167): the new values of the changed fields, the messages added to the conversation and
 * the Run steps it created.
 */
export interface RunChanges {
  fields: Partial<Omit<RunData, 'messages'>>;
  messages: RunMessage[];
  /** Run steps to store (Issue #169): the child entities the Run created, as their snapshots. */
  steps?: RunStepSnapshot[];
  /** What a bring-up-to-date request records on its latest Follow-up entry (Issue #147). */
  followUpEntry?: BringUpDetails;
  /** The secret store's reference to the Run's Environment file snapshot (Issue #104). */
  environmentFileSecretRef?: string | null;
}
