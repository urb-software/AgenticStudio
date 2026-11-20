import { Inject, Injectable, Logger } from '@nestjs/common';
import { RepositoryFailure } from '../../../domain/value-objects/repository-failure.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';

@Injectable()
export class FailInterruptedFetchesHandler {
  private readonly logger = new Logger('FailInterruptedFetches');

  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  /** Idempotent: failing what is already failed changes nothing. */
  async execute(): Promise<void> {
    let failed = 0;
    for (const projectId of await this.repositories.listIdsInState('fetching')) {
      await this.repositories.change(projectId, (stored) => {
        if (stored.failFetch(RepositoryFailure.interrupted(), { cloneKept: true })) failed += 1;
      });
    }
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} interrupted repository fetch(es) as failed.`);
    }
  }
}
