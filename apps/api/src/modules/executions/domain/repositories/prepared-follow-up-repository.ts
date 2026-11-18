import type { PreparedFollowUp } from '../entities/prepared-follow-up.js';
import type { PreparedFollowUpSnapshot } from '../entities/prepared-follow-up-snapshot.js';
import type { FollowUpSource } from '../value-objects/follow-up.js';

/** DI token for the {@link PreparedFollowUpRepository} adapter. */
export const PREPARED_FOLLOW_UP_REPOSITORY = Symbol('PREPARED_FOLLOW_UP_REPOSITORY');

/**
 * The store of the Follow-up Studio prepared for the operator to review (Issue #145): at most
 * one per Run. A preparation is stored by the answer of the lookup that read it and sent through
 * the normal Follow-up, which removes it; nothing here sends anything.
 */
export interface PreparedFollowUpRepository {
  /** The Run's prepared Follow-up, or `null` when there is none. */
  find(runId: string): Promise<PreparedFollowUpSnapshot | null>;

  /** The ids among `runIds` of the Runs that have a prepared Follow-up. */
  findRunIdsAmong(runIds: readonly string[]): Promise<ReadonlySet<string>>;

  /** Stores the Run's prepared Follow-up at `now`, replacing an earlier one (one per Run). */
  replace(runId: string, draft: PreparedFollowUp, now: Date): Promise<void>;

  /**
   * Removes the Run's prepared Follow-up (the operator discarded it, or the Follow-up prepared
   * from it was sent); a missing one is fine. With `source`, only one prepared from it.
   */
  discard(runId: string, source?: FollowUpSource): Promise<void>;
}
