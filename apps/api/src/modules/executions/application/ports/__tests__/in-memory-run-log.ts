import { planLogAppend, type RunEvent } from '../../../domain/value-objects/run-event.js';
import { CLAIMED_RUN_STATES } from '../../../domain/entities/run.js';
import type { RunLog } from '../run-log.js';
import type { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';

/**
 * In-memory adapter of {@link RunLog} for handler tests, with the database adapter's
 * rules: appends only for the holding worker of a `preparing` or `running` Run, stored seqs
 * ignored, the cap applied per Run.
 */
export class InMemoryRunLog implements RunLog {
  readonly events = new Map<string, RunEvent[]>();
  private readonly caps = new Map<string, { bytes: number; truncated: boolean }>();

  constructor(private readonly runs: InMemoryRunRepository) {}

  append(
    runId: string,
    workerId: string,
    events: readonly RunEvent[],
    maxBytes: number,
  ): Promise<number | null> {
    const run = this.runs.runs.find((candidate) => candidate.id === runId);
    const held = (CLAIMED_RUN_STATES as readonly string[]).includes(run?.state ?? '');
    if (!run || !held || run.claimedBy !== workerId) {
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

  lastSeq(runId: string): Promise<number> {
    return Promise.resolve((this.events.get(runId) ?? []).at(-1)?.seq ?? 0);
  }

  listAfter(runId: string, after: number, limit: number): Promise<RunEvent[]> {
    const events = (this.events.get(runId) ?? []).filter((event) => event.seq > after);
    return Promise.resolve(structuredClone(events.slice(0, limit)));
  }
}
