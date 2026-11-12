export class PrismaProjectRepository {
  async existsByName(name: string): Promise<boolean> {
    return name.length === 0;
  }
}
