import type { RunStep } from '../entities/run-step.js';
import type { Run } from '../entities/run.js';

export interface RunRepository {
  findById(id: string): Promise<Run | null>;
  listSteps(runId: string): Promise<RunStep[]>;
}
