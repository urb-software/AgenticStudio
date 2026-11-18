import { Inject, Injectable } from '@nestjs/common';
import type { ProjectSnapshot } from '../../../domain/entities/project-snapshot.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { ProjectName } from '../../../domain/value-objects/project-name.js';

export interface CreateProjectInput {
  /** The name as entered; normalized and validated here. */
  name: string;
}

/** The new project. */
export type CreateProjectResult = ProjectSnapshot;

/**
 * Command: creates a project. Throws `InvalidProjectNameError` for an empty or too long
 * name and `ProjectNameTakenError` when the name is taken (case-insensitively).
 */
@Injectable()
export class CreateProjectHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(input: CreateProjectInput): Promise<CreateProjectResult> {
    const project = await this.projects.add(ProjectName.parse(input.name));
    return project.snapshot();
  }
}
