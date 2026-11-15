import type { ProjectResponse } from '../../../projects/contracts/http/project-response.js';

export class ListRunsHandler {
  async execute(project: ProjectResponse): Promise<string[]> {
    return [project.id];
  }
}
