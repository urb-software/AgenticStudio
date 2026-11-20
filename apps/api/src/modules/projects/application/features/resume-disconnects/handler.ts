import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { RepositoryCleanup } from '../../repository-cleanup.js';

/**
 * Start-up: resumes the cleanup of every `disconnecting` Repository. Runs after the Git
 * adapter's sweep and before the repository worker starts; never throws, so one Repository
 * that still cannot be cleaned up does not stop the others or the start-up.
 */
@Injectable()
export class ResumeDisconnectsHandler {
  private readonly logger = new Logger('DisconnectRepository');

  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    private readonly cleanup: RepositoryCleanup,
  ) {}

  async execute(): Promise<void> {
    for (const projectId of await this.repositories.listIdsInState('disconnecting')) {
      try {
        await this.cleanup.finish(projectId);
      } catch (error) {
        this.logger.warn(
          `Disconnect of project ${projectId}: could not finish; it stays disconnecting and is ` +
            `retried at start-up and on a repeated disconnect. ${redactSecrets(String(error))}`,
        );
      }
    }
  }
}
