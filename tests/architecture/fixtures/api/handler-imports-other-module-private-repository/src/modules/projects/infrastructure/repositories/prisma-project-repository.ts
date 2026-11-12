export class PrismaProjectRepository {
  async exists(projectId: string): Promise<boolean> {
    return projectId.length > 0;
  }
}
