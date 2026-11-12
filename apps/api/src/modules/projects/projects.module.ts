import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { PROJECT_REPOSITORY } from './domain/repositories/project-repository.js';
import { CreateProjectEndpoint } from './features/create-project/endpoint.js';
import { CreateProjectHandler } from './features/create-project/handler.js';
import { ListProjectsEndpoint } from './features/list-projects/endpoint.js';
import { ListProjectsHandler } from './features/list-projects/handler.js';
import { PrismaProjectRepository } from './infrastructure/repositories/prisma-project-repository.js';

/** `projects` business module: create and list projects (Story #16). */
@Module({
  imports: [DatabaseModule],
  controllers: [CreateProjectEndpoint, ListProjectsEndpoint],
  providers: [
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
    CreateProjectHandler,
    ListProjectsHandler,
  ],
})
export class ProjectsModule {}
