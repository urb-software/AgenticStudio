import type { RunStartPoints } from '../../../contracts/index.js';

export type GetRunStartPointInput = { projectId: string };
export type GetRunStartPointResult = string | null;

export class GetRunStartPointHandler implements RunStartPoints {
  async forProject(projectId: string): Promise<string | null> {
    return projectId.length > 0 ? 'abc123' : null;
  }

  async execute(input: GetRunStartPointInput): Promise<GetRunStartPointResult> {
    return this.forProject(input.projectId);
  }
}
