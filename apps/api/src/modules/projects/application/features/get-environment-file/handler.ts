import { Inject, Injectable } from '@nestjs/common';
import { environmentFileView, type EnvironmentFileView } from '../../environment-file-view.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../../domain/repositories/environment-file-repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';

export interface GetEnvironmentFileInput {
  projectId: string;
}

export type GetEnvironmentFileResult = EnvironmentFileView | null;

/**
 * Never returns the content. Throws {@link ProjectNotFoundError}, or {@link
 * DefinitionsProjectError} for the definitions Repository.
 */
@Injectable()
export class GetEnvironmentFileHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
  ) {}

  async execute(input: GetEnvironmentFileInput): Promise<GetEnvironmentFileResult> {
    const { projectId } = input;
    const project = isProjectId(projectId) ? await this.projects.findById(projectId) : null;
    if (!project) throw new ProjectNotFoundError();
    project.assertAcceptsEnvironmentFile();
    const file = await this.files.find(projectId);
    return file ? environmentFileView(file) : null;
  }
}
