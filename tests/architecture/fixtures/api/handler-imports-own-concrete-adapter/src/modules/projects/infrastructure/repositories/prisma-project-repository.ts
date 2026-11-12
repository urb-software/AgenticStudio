export class PrismaProjectRepository {
  readonly names: string[] = [];

  async add(name: string): Promise<void> {
    this.names.push(name);
  }
}
