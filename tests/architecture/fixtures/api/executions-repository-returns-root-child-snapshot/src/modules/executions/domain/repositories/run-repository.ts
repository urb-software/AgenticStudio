import type { Run } from '../entities/run.js';
import type { RunStepSnapshot } from '../value-objects/run-step-snapshot.js';

export interface RunRepository {
  findById(id: string): Promise<Run | null>;
  listSteps(runId: string): Promise<RunStepSnapshot[]>;
}
