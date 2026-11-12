import { PrismaClient } from '@prisma/client';

export class ProjectSearch {
  constructor(private readonly prisma: PrismaClient) {}

  async count(): Promise<number> {
    return this.prisma.project.count();
  }
}
