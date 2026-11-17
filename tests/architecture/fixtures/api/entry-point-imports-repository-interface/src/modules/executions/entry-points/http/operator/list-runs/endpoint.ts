import type { RunRepository } from '../../../../domain/repositories/run-repository.js';

export class ListRunsEndpoint {
  constructor(private readonly runs: RunRepository) {}

  count(): Promise<number> {
    return this.runs.count();
  }
}
