import { Inject, Injectable } from '@nestjs/common';
import type { Run } from '../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';

/** Query (Issue #96): every Run of every project, newest first. */
@Injectable()
export class ListRunsHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  execute(): Promise<Run[]> {
    return this.runs.listNewestFirst();
  }
}
