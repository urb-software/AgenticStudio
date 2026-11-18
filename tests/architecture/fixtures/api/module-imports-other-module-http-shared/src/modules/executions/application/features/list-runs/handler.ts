import type { ProjectResponse } from '../../../../projects/entry-points/http/shared/project-response.js';

export type ListRunsInput = ProjectResponse;
export type ListRunsResult = string[];

export class ListRunsHandler {
  async execute(project: ListRunsInput): Promise<ListRunsResult> {
    return [project.id];
  }
}
