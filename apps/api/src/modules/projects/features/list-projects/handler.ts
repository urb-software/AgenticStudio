import { Inject, Injectable } from '@nestjs/common';
import type { Project } from '../../domain/entities/project.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';

/** Query: every project, newest first. No pagination (out of scope for Story #16). */
@Injectable()
export class ListProjectsHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  execute(): Promise<Project[]> {
    return this.projects.listNewestFirst();
  }
}
