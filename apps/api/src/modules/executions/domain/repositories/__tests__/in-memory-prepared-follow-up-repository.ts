import { PreparedFollowUp } from '../../entities/prepared-follow-up.js';
import type { FollowUpSource } from '../../value-objects/follow-up-source.js';
import type { PreparedFollowUpRepository } from '../prepared-follow-up-repository.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

/** In-memory {@link PreparedFollowUpRepository}; stores in the Run fake's `prepared` map. */
export class InMemoryPreparedFollowUpRepository implements PreparedFollowUpRepository {
  constructor(private readonly runs: InMemoryRunRepository) {}

  find(runId: string): Promise<PreparedFollowUp | null> {
    const stored = this.runs.prepared.get(runId);
    return Promise.resolve(
      stored ? PreparedFollowUp.restore({ ...stored, items: [...stored.items] }) : null,
    );
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
