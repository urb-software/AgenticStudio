import type * as ports from '../../application/ports/project-reader.js';

export class PrismaProjectReader implements ports.ProjectReader {
  async findName(projectId: string): Promise<string | null> {
    return projectId;
  }
}
