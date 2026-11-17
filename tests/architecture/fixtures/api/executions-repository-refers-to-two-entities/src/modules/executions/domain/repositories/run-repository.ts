import type { RunLookup } from '../entities/run-lookup.js';
import type { Run } from '../entities/run.js';

export interface RunRepository {
  findById(id: string): Promise<Run | null>;
  findLookup(id: string): Promise<RunLookup | null>;
}
