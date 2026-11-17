import type { ProjectResponse } from '../../../../projects/contracts/http/project-response.js';

export type ListRunsInput = ProjectResponse;
export type ListRunsResult = string[];

export class ListRunsHandler {
  async execute(project: ListRunsInput): Promise<ListRunsResult> {
    return [project.id];
  }
}
