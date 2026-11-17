import type { RunStartPoints } from '../../../contracts/index.js';

export class GetRunStartPointHandler implements RunStartPoints {
  async forProject(projectId: string): Promise<string | null> {
    return projectId.length > 0 ? 'abc123' : null;
  }
}
