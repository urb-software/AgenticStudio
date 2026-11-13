import type { ProjectSummaryV1 } from '../../../projects/contracts/index.js';

export class StartExecutionHandler {
  canStart(project: ProjectSummaryV1): boolean {
    return project.name.length > 0;
  }
}
