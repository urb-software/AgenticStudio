import { Inject, Injectable } from '@nestjs/common';
import { environmentFileView, type EnvironmentFileView } from '../../environment-file-view.js';
import { EnvironmentFilePathTrackedError } from '../../../domain/errors/environment-file-errors.js';
import { EnvironmentFile } from '../../../domain/entities/environment-file.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import { EnvironmentFileContent } from '../../../domain/value-objects/environment-file-content.js';
import { EnvironmentFilePath } from '../../../domain/value-objects/environment-file-path.js';
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
import {
  DefinitionsProjectError,
  ProjectNotFoundError,
} from '../../../domain/errors/project-errors.js';

export interface SetEnvironmentFileInput {
  projectId: string;
  path: string;
  /** Test values only (security.md §3); never logged or returned. */
  content: string;
}

export type SetEnvironmentFileResult = EnvironmentFileView;

/**
 * Throws {@link ProjectNotFoundError}, {@link DefinitionsProjectError},
 * `InvalidEnvironmentFilePathError` (including
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
    const project = isProjectId(input.projectId)
      ? await this.projects.findById(input.projectId)
      : null;
    if (!project) throw new ProjectNotFoundError();
    if (project.kind === 'definitions') throw new DefinitionsProjectError();
    const path = EnvironmentFilePath.of(input.path);
    const content = EnvironmentFileContent.of(input.content);
    await this.refuseTrackedPath(input.projectId, path.value);

    const secretRef = await this.contents.store(content.value);
    let result: Awaited<ReturnType<EnvironmentFileRepository['save']>>;
    try {
      const file = EnvironmentFile.create({
        projectId: input.projectId,
        path,
        content,
        secretRef,
        now: new Date(),
      });
      result = await this.files.save(file);
    } catch (error) {
      await this.contents.discard(secretRef);
      throw error;
    }
    if (result.replacedSecretRef !== null) await this.contents.discard(result.replacedSecretRef);
    return environmentFileView(result.saved);
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
