import { Injectable, Logger } from '@nestjs/common';
import type { IntegrationFetchResult, RunIntegrationFetches } from '../../contracts/index.js';
import { FetchRepositoryHandler } from '../../application/features/fetch-repository/handler.js';

/**
 * The driving adapter for another module's call through `contracts/`: it maps the call to the
 * Repository fetch and a refusal to `not_started`.
 */
@Injectable()
export class ProjectRunIntegrationFetches implements RunIntegrationFetches {
  private readonly logger = new Logger(ProjectRunIntegrationFetches.name);

  constructor(private readonly handler: FetchRepositoryHandler) {}

  async fetchIntegrationBranch(projectId: string): Promise<IntegrationFetchResult> {
    try {
      await this.handler.execute({ projectId });
      return { status: 'started' };
    } catch (error) {
      this.logger.warn(
        `The Integration branch of project ${projectId} was not fetched: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return { status: 'not_started' };
    }
  }
}
