import type { PreparedFollowUp } from '../entities/run-lookup.js';

/** DI token for the {@link PreparedFollowUpRepository} adapter. */
export const PREPARED_FOLLOW_UP_REPOSITORY = Symbol('PREPARED_FOLLOW_UP_REPOSITORY');

/**
 * The store of the Follow-up Studio prepared for the operator to review (Issue #145): at most
 * one per Run. A preparation is stored by the lookup that read it
 * ({@link RunLookupRepository.completeFailingCheckLogs}) and sent through the normal Follow-up,
 * which removes it; nothing here sends anything.
 */
export interface PreparedFollowUpRepository {
  /** The Run's prepared Follow-up, or `null` when there is none. */
  find(runId: string): Promise<PreparedFollowUp | null>;

  /** Removes the Run's prepared Follow-up (the operator discarded it); a missing one is fine. */
  discard(runId: string): Promise<void>;
}
