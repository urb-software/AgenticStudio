import { Inject, Injectable } from '@nestjs/common';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import type { MergeMethod } from '../../../domain/value-objects/merge-method.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';

export interface GetRunMergeMethodInput {
  projectId: string;
}

export type GetRunMergeMethodResult = MergeMethod;

/** The Project's merge method, for `executions` only. Throws {@link ProjectNotFoundError}. */
@Injectable()
export class GetRunMergeMethodHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(input: GetRunMergeMethodInput): Promise<GetRunMergeMethodResult> {
    const project = isProjectId(input.projectId)
      ? await this.projects.findById(input.projectId)
      : null;
    if (!project) throw new ProjectNotFoundError();
    return project.mergeMethod;
  }
}
