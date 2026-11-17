import type { ProjectResponse } from '../../shared/project-response.js';

export class GetProjectEndpoint {
  get(id: string): ProjectResponse {
    return { id };
  }
}
