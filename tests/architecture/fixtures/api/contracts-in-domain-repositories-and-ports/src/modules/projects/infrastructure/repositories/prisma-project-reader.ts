import type * as ports from '../../ports/project-reader.js';

export class PrismaProjectReader implements ports.ProjectReader {
  async findName(projectId: string): Promise<string | null> {
    return projectId;
  }
}
