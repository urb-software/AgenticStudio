import { Inject, Injectable } from '@nestjs/common';
import { projectView, type ProjectView } from '../../project-view.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';

export type ListProjectsResult = readonly ProjectView[];

@Injectable()
export class ListProjectsHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(): Promise<ListProjectsResult> {
    const projects = await this.projects.listNewestFirst();
    return projects.map(projectView);
  }
}
