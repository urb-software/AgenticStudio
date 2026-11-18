import type { RunStepSnapshot } from './run-step-snapshot.js';
import type { BringUpDetails } from '../value-objects/bring-up-details.js';
import type { RunMessage } from '../value-objects/run-message.js';
import type { RunData } from './run-data.js';

/** What changed on a Run since it was started or restored, for the store to save in one step. */
export interface RunChanges {
  fields: Partial<Omit<RunData, 'messages'>>;
  messages: RunMessage[];
  steps?: RunStepSnapshot[];
  followUpEntry?: BringUpDetails;
  environmentFileSecretRef?: string | null;
}
