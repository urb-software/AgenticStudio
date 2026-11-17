import { CLOCK, type Clock } from '../../../../application/ports/clock.js';
import {
  RUN_REPOSITORY,
  type RunRepository,
} from '../../../../domain/repositories/run-repository.js';

export class ListRunsEndpoint {
  constructor(
    private readonly runs: RunRepository,
    private readonly clock: Clock,
  ) {}

  tokens(): symbol[] {
    return [RUN_REPOSITORY, CLOCK];
  }

  async count(): Promise<number> {
    return (await this.runs.count()) + this.clock.now();
  }
}
