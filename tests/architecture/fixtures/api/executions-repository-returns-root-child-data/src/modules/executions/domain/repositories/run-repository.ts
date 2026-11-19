import type { Run } from '../entities/run.js';
import type { RunStepData } from '../entities/run-step-data.js';

export interface RunRepository {
  findById(id: string): Promise<Run | null>;
  listSteps(runId: string): Promise<RunStepData[]>;
}
