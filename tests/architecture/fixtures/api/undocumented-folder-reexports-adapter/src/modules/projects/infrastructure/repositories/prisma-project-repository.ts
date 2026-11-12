export class PrismaProjectRepository {
  async findName(projectId: string): Promise<string> {
    return projectId;
  }
}
