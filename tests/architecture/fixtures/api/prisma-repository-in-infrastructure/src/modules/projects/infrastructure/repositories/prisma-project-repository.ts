import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import type { ProjectRepository } from '../../domain/repositories/project-repository.js';

@Injectable()
export class PrismaProjectRepository implements ProjectRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient) {}

  async add(name: string): Promise<void> {
    await this.prisma.project.create({ data: { name } });
  }
}
