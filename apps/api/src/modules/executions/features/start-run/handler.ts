import { Inject, Injectable } from '@nestjs/common';
import { RUN_START_POINTS, type RunStartPoints } from '../../../projects/contracts/index.js';
import {
  type Provider,
  RepositoryNotReadyError,
  type Run,
  RunProjectNotFoundError,
} from '../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';

export interface StartRunInput {
  projectId: string;
  provider: Provider;
  /** Validated by the caller (1–20 000 characters). */
  task: string;
}

/**
 * Command (Issue #96): queues a Run of a project from the current commit of its integration
 * branch, which `projects` provides through its public contract. Throws
 * {@link RunProjectNotFoundError} or {@link RepositoryNotReadyError}.
 */
@Injectable()
export class StartRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_START_POINTS) private readonly startPoints: RunStartPoints,
  ) {}

  async execute(input: StartRunInput): Promise<Run> {
    const startPoint = await this.startPoints.forProject(input.projectId);
    switch (startPoint.status) {
      case 'project_not_found':
        throw new RunProjectNotFoundError();
      case 'no_repository':
        throw new RepositoryNotReadyError('no_repository');
      case 'repository_not_ready':
        throw new RepositoryNotReadyError('not_ready');
      case 'ready':
        return this.runs.add({ ...input, startCommit: startPoint.startCommit });
    }
  }
}
