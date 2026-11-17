import type { PreparedFollowUp } from '../../entities/prepared-follow-up.js';
import type { PreparedFollowUpSnapshot } from '../../value-objects/prepared-follow-up-snapshot.js';
import type { FollowUpSource } from '../../value-objects/follow-up.js';
import type { PreparedFollowUpRepository } from '../prepared-follow-up-repository.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

/**
 * In-memory adapter of {@link PreparedFollowUpRepository} for handler tests, with the database
 * adapter's rules: one per Run, a new preparation replaces it, discarding what is not there is
 * fine. The storage is the Run fake's `prepared` map, so a test can set up and read it.
 */
export class InMemoryPreparedFollowUpRepository implements PreparedFollowUpRepository {
  constructor(private readonly runs: InMemoryRunRepository) {}

  find(runId: string): Promise<PreparedFollowUpSnapshot | null> {
    return Promise.resolve(this.runs.prepared.get(runId) ?? null);
  }

  findRunIdsAmong(runIds: readonly string[]): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(runIds.filter((runId) => this.runs.prepared.has(runId))));
  }

  replace(runId: string, draft: PreparedFollowUp): Promise<void> {
    this.runs.prepared.set(runId, draft.snapshot());
    return Promise.resolve();
  }

  discard(runId: string, source?: FollowUpSource): Promise<void> {
    if (source === undefined || this.runs.prepared.get(runId)?.source === source) {
      this.runs.prepared.delete(runId);
    }
    return Promise.resolve();
  }
}
