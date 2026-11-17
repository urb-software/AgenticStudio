import { Inject, Injectable } from '@nestjs/common';
import type { EnvironmentFileInfo } from '../../../domain/value-objects/environment-file.js';
import { isProjectId } from '../../../domain/value-objects/project.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../../domain/repositories/environment-file-repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';

/**
 * Query (Issue #104): what the operator may see of the project's Environment file (path, size,
 * last change), never its content; `null` when none is set. Throws {@link ProjectNotFoundError}.
 */
@Injectable()
export class GetEnvironmentFileHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
  ) {}

  async execute(projectId: string): Promise<EnvironmentFileInfo | null> {
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      throw new ProjectNotFoundError();
    }
    const file = await this.files.find(projectId);
    return file ? { path: file.path, sizeBytes: file.sizeBytes, updatedAt: file.updatedAt } : null;
  }
}
