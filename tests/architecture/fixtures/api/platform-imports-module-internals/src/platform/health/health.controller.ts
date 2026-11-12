import { ListProjectsHandler } from '../../modules/projects/features/list-projects/handler.js';

export class HealthController {
  constructor(private readonly projects: ListProjectsHandler) {}

  async check(): Promise<boolean> {
    return (await this.projects.execute()).length >= 0;
  }
}
