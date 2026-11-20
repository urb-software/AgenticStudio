import type { RunStartPoints } from '../../contracts/index.js';
import type { GetRunStartPointHandler } from '../../application/features/get-run-start-point/handler.js';

export class ProjectRunStartPoints implements RunStartPoints {
  constructor(private readonly handler: GetRunStartPointHandler) {}

  forProject(projectId: string): Promise<string | null> {
    return this.handler.execute({ projectId });
  }
}
