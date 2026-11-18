import {
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import type { Clock } from '../../ports/clock.js';
import { pageSize } from './page-size.js';

export type ListRunsResult = number;

export class ListRunsHandler {
  constructor(
    private readonly runs: RunRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<ListRunsResult> {
    if ((await this.runs.count()) < 0) throw new RunNotFoundError();
    return pageSize + this.clock.now();
  }
}
