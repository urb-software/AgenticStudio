import type { ProjectSummary } from '../../../projects/contracts/index.js';

export class StartExecutionHandler {
  canStart(project: ProjectSummary): boolean {
    return project.name.length > 0;
  }
}
