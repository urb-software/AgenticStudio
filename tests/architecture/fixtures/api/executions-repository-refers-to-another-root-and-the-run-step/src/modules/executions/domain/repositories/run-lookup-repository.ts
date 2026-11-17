import type { RunLookup } from '../entities/run-lookup.js';
import type { RunStep } from '../entities/run-step.js';

export interface RunLookupRepository {
  findById(id: string): Promise<RunLookup | null>;
  listSteps(runId: string): Promise<RunStep[]>;
}
