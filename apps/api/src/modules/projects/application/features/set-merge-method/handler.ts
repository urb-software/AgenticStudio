import { Inject, Injectable } from '@nestjs/common';
import { projectView, type ProjectView } from '../../project-view.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { isMergeMethod, type MergeMethod } from '../../../domain/value-objects/merge-method.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';

export interface SetMergeMethodInput {
  projectId: string;
  mergeMethod: MergeMethod;
}

export type SetMergeMethodResult = ProjectView;

/**
 * Sets how the Project's Runs are merged. It applies to merges approved afterwards; a Merge
 * approval already stored keeps the method it recorded. Throws {@link ProjectNotFoundError}, and
 * an `Error` for a value outside the list (the request schema refuses it first).
 */
@Injectable()
export class SetMergeMethodHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(input: SetMergeMethodInput): Promise<SetMergeMethodResult> {
    if (!isMergeMethod(input.mergeMethod)) throw new Error('The merge method is unknown.');
    if (!isProjectId(input.projectId)) throw new ProjectNotFoundError();
    const project = await this.projects.findById(input.projectId);
    if (!project) throw new ProjectNotFoundError();
    const changed = project.withMergeMethod(input.mergeMethod);
    if (!(await this.projects.save(changed))) throw new ProjectNotFoundError();
    return projectView(changed);
  }
}
