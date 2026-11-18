import { Inject, Injectable } from '@nestjs/common';
import { projectView, type ProjectView } from '../../project-view.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { ProjectName } from '../../../domain/value-objects/project-name.js';

export interface CreateProjectInput {
  name: string;
}

export type CreateProjectResult = ProjectView;

/**
 * Throws `InvalidProjectNameError` for an empty or too long name and `ProjectNameTakenError`
 * when the name is taken (case-insensitively).
 */
@Injectable()
export class CreateProjectHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(input: CreateProjectInput): Promise<CreateProjectResult> {
    const project = await this.projects.add(ProjectName.parse(input.name));
    return projectView(project);
  }
}
