import type { ProjectSummaryV1 } from '../../../../projects/contracts/index.js';

export type StartExecutionInput = ProjectSummaryV1;
export type StartExecutionResult = boolean;

export class StartExecutionHandler {
  execute(project: StartExecutionInput): StartExecutionResult {
    return project.name.length > 0;
  }
}
