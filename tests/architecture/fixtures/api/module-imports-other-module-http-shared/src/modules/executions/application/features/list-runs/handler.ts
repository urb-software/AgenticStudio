import type { ProjectResponse } from '../../../../projects/entry-points/http/shared/project-response.js';

export class ListRunsHandler {
  async execute(project: ProjectResponse): Promise<string[]> {
    return [project.id];
  }
}
