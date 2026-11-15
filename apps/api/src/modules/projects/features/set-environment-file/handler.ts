import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { SECRET_STORE, type SecretStore } from '../../../../platform/secrets/index.js';
import {
  checkEnvironmentFile,
  ENVIRONMENT_FILE_SECRET_OWNER,
  type EnvironmentFileInfo,
  EnvironmentFilePathTrackedError,
} from '../../domain/entities/environment-file.js';
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
import {
  GitCloneMissingError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface SetEnvironmentFileInput {
  projectId: string;
  path: string;
  /** Test values only (security.md §3); never logged or returned. */
  content: string;
}

/**
 * Command (Issue #104): sets the project's Environment file, new or replacing the one there.
 * The content is stored in the secret store under its own owner label; the project keeps the
 * reference with the path, size and time, and the replaced content is deleted. When the
 * project's Clone is ready, a path tracked at the integration branch's current commit is
 * refused (the agent worker re-checks against the Run's start commit). Returns what the
 * operator may see. Throws {@link ProjectNotFoundError}, `InvalidEnvironmentFilePathError`
 * (including {@link EnvironmentFilePathTrackedError}) or `InvalidEnvironmentFileContentError`.
 */
@Injectable()
export class SetEnvironmentFileHandler {
  private readonly logger = new Logger('EnvironmentFile');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  async execute(input: SetEnvironmentFileInput): Promise<EnvironmentFileInfo> {
    if (!isProjectId(input.projectId) || !(await this.projects.findById(input.projectId))) {
      throw new ProjectNotFoundError();
    }
    const { sizeBytes } = checkEnvironmentFile(input.path, input.content);
    await this.refuseTrackedPath(input.projectId, input.path);

    const secretRef = await this.secrets.put(input.content, {
      owner: ENVIRONMENT_FILE_SECRET_OWNER,
    });
    let result: Awaited<ReturnType<EnvironmentFileRepository['save']>>;
    try {
      result = await this.files.save(input.projectId, { path: input.path, sizeBytes, secretRef });
    } catch (error) {
      await this.deleteQuietly(secretRef);
      throw error;
    }
    if (result.replacedSecretRef !== null) await this.deleteQuietly(result.replacedSecretRef);
    return result.saved;
  }

  /** The tracked-path check of a ready Clone; skipped without one (the worker re-checks). */
  private async refuseTrackedPath(projectId: string, path: string): Promise<void> {
    const repository = await this.projects.findRepository(projectId);
    if (!repository || repository.state !== 'ready' || repository.headSha === null) return;
    let tracked: boolean;
    try {
      tracked = await this.git.isPathTracked(projectId, repository.headSha, path);
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError || error instanceof GitCloneMissingError) {
        return;
      }
      throw error;
    }
    if (tracked) throw new EnvironmentFilePathTrackedError();
  }

  /** A content no row references any more; a failed delete is left to the orphan sweep. */
  private async deleteQuietly(secretRef: string): Promise<void> {
    try {
      await this.secrets.delete(secretRef);
    } catch (error) {
      this.logger.warn(
        `Could not delete the Environment file secret ${secretRef}; the orphan sweep deletes ` +
          `it later. ${redactSecrets(String(error))}`,
      );
    }
  }
}
