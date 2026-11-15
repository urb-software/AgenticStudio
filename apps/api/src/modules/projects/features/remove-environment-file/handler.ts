import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { SECRET_STORE, type SecretStore } from '../../../../platform/secrets/index.js';
import { isProjectId } from '../../domain/entities/project.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../domain/repositories/environment-file-repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';

/**
 * Command (Issue #104): removes the project's Environment file and deletes its content from
 * the secret store. Runs claimed earlier keep their own snapshot; later Runs get none.
 * Removing a file that is not there changes nothing. Throws {@link ProjectNotFoundError}.
 */
@Injectable()
export class RemoveEnvironmentFileHandler {
  private readonly logger = new Logger('EnvironmentFile');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  async execute(projectId: string): Promise<void> {
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      throw new ProjectNotFoundError();
    }
    const secretRef = await this.files.delete(projectId);
    if (secretRef === null) return;
    try {
      await this.secrets.delete(secretRef);
    } catch (error) {
      // Nothing references it any more: the orphan sweep deletes it later.
      this.logger.warn(
        `Could not delete the Environment file secret ${secretRef}; the orphan sweep deletes ` +
          `it later. ${redactSecrets(String(error))}`,
      );
    }
  }
}
