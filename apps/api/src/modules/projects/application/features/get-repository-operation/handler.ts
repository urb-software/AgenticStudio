import { Inject, Injectable } from '@nestjs/common';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import type { RepositoryOperation } from '../../ports/repository-jobs.js';

export interface GetRepositoryOperationInput {
  projectId: string;
}

/** The background operation the Repository's job runs, or `null` when there is none. */
export type GetRepositoryOperationResult = RepositoryOperation | null;

/**
 * Query: which background operation the Repository's job runs. The Repository's state says it:
 * `connecting` runs the clone, `fetching` runs the fetch. `null` when the project has no
 * Repository or it is in any other state (a job left over from before a restart, or one of a
 * Repository that is now disconnecting): there is then nothing for the job to do.
 */
@Injectable()
export class GetRepositoryOperationHandler {
  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  async execute(input: GetRepositoryOperationInput): Promise<GetRepositoryOperationResult> {
    const repository = await this.repositories.find(input.projectId);
    return repository?.pendingOperation ?? null;
  }
}
