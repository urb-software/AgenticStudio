import { Inject, Injectable } from '@nestjs/common';
import type { EnvironmentFileSnapshot } from '../../../domain/entities/environment-file-snapshot.js';
import { EnvironmentFilePathTrackedError } from '../../../domain/errors/environment-file-errors.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import { checkEnvironmentFile } from './check.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../../domain/repositories/environment-file-repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import {
  ENVIRONMENT_FILE_CONTENTS,
  type EnvironmentFileContents,
} from '../../ports/environment-file-contents.js';
import {
  GitCloneMissingError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';

export interface SetEnvironmentFileInput {
  projectId: string;
  path: string;
  /** Test values only (security.md §3); never logged or returned. */
  content: string;
}

export type SetEnvironmentFileResult = EnvironmentFileSnapshot;

/**
 * Throws {@link ProjectNotFoundError}, `InvalidEnvironmentFilePathError` (including
 * {@link EnvironmentFilePathTrackedError}) or `InvalidEnvironmentFileContentError`.
 */
@Injectable()
export class SetEnvironmentFileHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
    @Inject(ENVIRONMENT_FILE_CONTENTS) private readonly contents: EnvironmentFileContents,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  async execute(input: SetEnvironmentFileInput): Promise<SetEnvironmentFileResult> {
    if (!isProjectId(input.projectId) || !(await this.projects.findById(input.projectId))) {
      throw new ProjectNotFoundError();
    }
    const { sizeBytes } = checkEnvironmentFile(input.path, input.content);
    await this.refuseTrackedPath(input.projectId, input.path);

    const secretRef = await this.contents.store(input.content);
    let result: Awaited<ReturnType<EnvironmentFileRepository['save']>>;
    try {
      result = await this.files.save(input.projectId, { path: input.path, sizeBytes, secretRef });
    } catch (error) {
      await this.contents.discard(secretRef);
      throw error;
    }
    if (result.replacedSecretRef !== null) await this.contents.discard(result.replacedSecretRef);
    return result.saved.snapshot();
  }

  /** The tracked-path check of a ready Clone; skipped without one (the worker re-checks). */
  private async refuseTrackedPath(projectId: string, path: string): Promise<void> {
    const repository = await this.repositories.find(projectId);
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
}
