import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../../domain/repositories/environment-file-repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  ENVIRONMENT_FILE_CONTENTS,
  type EnvironmentFileContents,
} from '../../ports/environment-file-contents.js';
import {
  DefinitionsProjectError,
  ProjectNotFoundError,
} from '../../../domain/errors/project-errors.js';

export interface RemoveEnvironmentFileInput {
  projectId: string;
}

/**
 * Removing none changes nothing; Runs claimed earlier keep their snapshot. Throws
 * {@link ProjectNotFoundError}, or {@link DefinitionsProjectError} for the definitions Repository.
 */
@Injectable()
export class RemoveEnvironmentFileHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
    @Inject(ENVIRONMENT_FILE_CONTENTS) private readonly contents: EnvironmentFileContents,
  ) {}

  async execute(input: RemoveEnvironmentFileInput): Promise<void> {
    const { projectId } = input;
    const project = isProjectId(projectId) ? await this.projects.findById(projectId) : null;
    if (!project) throw new ProjectNotFoundError();
    if (project.kind === 'definitions') throw new DefinitionsProjectError();
    const secretRef = await this.files.delete(projectId);
    if (secretRef !== null) await this.contents.discard(secretRef);
  }
}
