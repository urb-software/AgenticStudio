import { Inject, Injectable } from '@nestjs/common';
import type { ProjectSnapshot } from '../../../domain/entities/project-snapshot.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';

/** Every project, newest first. */
export type ListProjectsResult = readonly ProjectSnapshot[];

/** Query: every project, newest first. No pagination (out of scope for Story #16). */
@Injectable()
export class ListProjectsHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(): Promise<ListProjectsResult> {
    const projects = await this.projects.listNewestFirst();
    return projects.map((project) => project.snapshot());
  }
}
