import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import type { ProjectKind } from '../../../domain/value-objects/project-kind.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';

export interface GetProjectKindInput {
  projectId: string;
}

/** `null` for an id that names no project. */
export type GetProjectKindResult = ProjectKind | null;

@Injectable()
export class GetProjectKindHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(input: GetProjectKindInput): Promise<GetProjectKindResult> {
    if (!isProjectId(input.projectId)) return null;
    return (await this.projects.findById(input.projectId))?.kind ?? null;
  }
}
