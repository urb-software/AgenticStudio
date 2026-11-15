import { Inject, Injectable } from '@nestjs/common';
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
  ENVIRONMENT_FILE_CONTENTS,
  type EnvironmentFileContents,
} from '../../ports/environment-file-contents.js';

/**
 * Command (Issue #104): removes the project's Environment file and deletes its content from
 * the secret store. Runs claimed earlier keep their own snapshot; later Runs get none.
 * Removing a file that is not there changes nothing. Throws {@link ProjectNotFoundError}.
 */
@Injectable()
export class RemoveEnvironmentFileHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
    @Inject(ENVIRONMENT_FILE_CONTENTS) private readonly contents: EnvironmentFileContents,
  ) {}

  async execute(projectId: string): Promise<void> {
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      throw new ProjectNotFoundError();
    }
    const secretRef = await this.files.delete(projectId);
    if (secretRef !== null) await this.contents.discard(secretRef);
  }
}
