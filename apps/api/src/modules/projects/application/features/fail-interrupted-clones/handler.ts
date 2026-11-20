import { Inject, Injectable, Logger } from '@nestjs/common';
import { RepositoryFailure } from '../../../domain/value-objects/repository-failure.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';

@Injectable()
export class FailInterruptedClonesHandler {
  private readonly logger = new Logger('FailInterruptedClones');

  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  /** Idempotent: failing what is already failed changes nothing. */
  async execute(): Promise<void> {
    let failed = 0;
    for (const projectId of await this.repositories.listIdsInState('connecting')) {
      await this.repositories.change(projectId, (stored) => {
        if (stored.failClone(RepositoryFailure.interrupted())) failed += 1;
      });
    }
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} interrupted repository connection(s) as failed.`);
    }
  }
}
