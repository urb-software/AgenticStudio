import type { RunStartPoints } from '../../../../projects/contracts/index.js';

export class StartRunHandler {
  constructor(private readonly startPoints: RunStartPoints) {}

  async execute(projectId: string): Promise<string | null> {
    return this.startPoints.forProject(projectId);
  }
}
