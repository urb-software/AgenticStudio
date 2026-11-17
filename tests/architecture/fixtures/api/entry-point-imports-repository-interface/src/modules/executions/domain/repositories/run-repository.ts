import type { Run } from '../entities/run.js';

export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');

export class RunNotFoundError extends Error {}

export interface RunRepository {
  findById(id: string): Promise<Run | null>;
  count(): Promise<number>;
}
