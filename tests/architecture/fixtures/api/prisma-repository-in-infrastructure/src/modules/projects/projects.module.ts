import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { PROJECT_REPOSITORY } from './domain/repositories/project-repository.js';
import { CreateProjectHandler } from './features/create-project/handler.js';
import { PrismaProjectRepository } from './infrastructure/repositories/prisma-project-repository.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
    CreateProjectHandler,
  ],
})
export class ProjectsModule {}
