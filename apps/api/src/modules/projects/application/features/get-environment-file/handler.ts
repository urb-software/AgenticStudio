import { Inject, Injectable } from '@nestjs/common';
import type { EnvironmentFileSnapshot } from '../../../domain/entities/environment-file-snapshot.js';
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

/** What the operator may see of the project's Environment file, or `null` when none is set. */
export type GetEnvironmentFileResult = EnvironmentFileSnapshot | null;

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

  async execute(input: GetEnvironmentFileInput): Promise<GetEnvironmentFileResult> {
    const { projectId } = input;
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      throw new ProjectNotFoundError();
    }
    const file = await this.files.find(projectId);
    return file ? file.snapshot() : null;
  }
}
