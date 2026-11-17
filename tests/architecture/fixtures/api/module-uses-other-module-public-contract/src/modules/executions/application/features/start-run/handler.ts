import type { RunStartPoints } from '../../../../projects/contracts/index.js';

export type StartRunInput = string;
export type StartRunResult = string | null;

export class StartRunHandler {
  constructor(private readonly startPoints: RunStartPoints) {}

  async execute(projectId: StartRunInput): Promise<StartRunResult> {
    return this.startPoints.forProject(projectId);
  }
}
