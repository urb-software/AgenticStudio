import { type NewRunEvent, planLogAppend, type RunEvent } from '../../entities/run-event.js';
import type { RunLogRepository } from '../run-log-repository.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

/**
 * In-memory adapter of {@link RunLogRepository} for handler tests, with the database adapter's
 * rules: appends only for the holding worker of a `preparing` or `running` Run, stored seqs
 * ignored, the cap applied per Run.
 */
export class InMemoryRunLogRepository implements RunLogRepository {
  readonly events = new Map<string, RunEvent[]>();
  private readonly caps = new Map<string, { bytes: number; truncated: boolean }>();

  constructor(private readonly runs: InMemoryRunRepository) {}

  append(
    runId: string,
    workerId: string,
    events: readonly NewRunEvent[],
    maxBytes: number,
  ): Promise<number | null> {
    const run = this.runs.runs.find((candidate) => candidate.id === runId);
    if (!run || !['preparing', 'running'].includes(run.state) || run.claimedBy !== workerId) {
      return Promise.resolve(null);
    }
    const stored = this.events.get(runId) ?? [];
    const seqs = new Set(stored.map((event) => event.seq));
    const plan = planLogAppend(
      this.caps.get(runId) ?? { bytes: 0, truncated: false },
      events.filter((event) => !seqs.has(event.seq)),
      maxBytes,
    );
    this.caps.set(runId, plan.state);
    this.events.set(
      runId,
      [...stored, ...structuredClone(plan.store)].sort((a, b) => a.seq - b.seq),
    );
    return Promise.resolve(plan.store.length);
  }

  listAfter(runId: string, after: number, limit: number): Promise<RunEvent[]> {
    const events = (this.events.get(runId) ?? []).filter((event) => event.seq > after);
    return Promise.resolve(structuredClone(events.slice(0, limit)));
  }
}
