import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { RepositoryFailure } from '../../../domain/value-objects/repository-failure.js';
import { type UnfinishedJob } from '../../../domain/value-objects/unfinished-job.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';

export interface RecordUnfinishedFetchInput {
  projectId: string;
  failure: UnfinishedJob;
}

@Injectable()
export class RecordUnfinishedFetchHandler {
  private readonly logger = new Logger('RecordUnfinishedFetch');

  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  /** A late write changes nothing: only a Repository still `fetching` takes the failure. */
  async execute(input: RecordUnfinishedFetchInput): Promise<void> {
    const { projectId, failure } = input;
    if (failure.reason === 'error') {
      this.logger.error(
        `Fetch of project ${projectId} failed unexpectedly: ${redactSecrets(String(failure.error))}`,
      );
    }
    await this.repositories.change(projectId, (stored) => {
      stored.failFetch(RepositoryFailure.fromUnfinishedJob('fetch', failure), { cloneKept: true });
    });
  }
}
