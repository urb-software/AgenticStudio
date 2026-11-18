import type { PreparedFollowUp } from '../entities/prepared-follow-up.js';
import type { PreparedFollowUpSnapshot } from '../entities/prepared-follow-up-snapshot.js';
import type { FollowUpSource } from '../value-objects/follow-up.js';

/** DI token for the {@link PreparedFollowUpRepository} adapter. */
export const PREPARED_FOLLOW_UP_REPOSITORY = Symbol('PREPARED_FOLLOW_UP_REPOSITORY');

/** At most one prepared Follow-up per Run. */
export interface PreparedFollowUpRepository {
  find(runId: string): Promise<PreparedFollowUpSnapshot | null>;

  findRunIdsAmong(runIds: readonly string[]): Promise<ReadonlySet<string>>;

  /** Replaces an earlier one. */
  replace(runId: string, draft: PreparedFollowUp, now: Date): Promise<void>;

  /** A missing one is fine. With `source`, only one prepared from it. */
  discard(runId: string, source?: FollowUpSource): Promise<void>;
}
