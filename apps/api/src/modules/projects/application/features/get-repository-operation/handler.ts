import { Inject, Injectable } from '@nestjs/common';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import type { RepositoryOperation } from '../../ports/repository-jobs.js';

export interface GetRepositoryOperationInput {
  projectId: string;
}

export type GetRepositoryOperationResult = RepositoryOperation | null;

/**
 * `null` when the Repository is absent or in a state without a job.
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
