import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { PROJECT_REPOSITORY } from './domain/repositories/project-repository.js';
import { CreateProjectEndpoint } from './features/create-project/endpoint.js';
import { CreateProjectHandler } from './features/create-project/handler.js';
import { ListProjectsEndpoint } from './features/list-projects/endpoint.js';
import { ListProjectsHandler } from './features/list-projects/handler.js';
import {
  SystemGitAdapter,
  systemGitSettings,
} from './infrastructure/adapters/git/system-git-adapter.js';
import { PrismaProjectRepository } from './infrastructure/repositories/prisma-project-repository.js';
import { REPOSITORY_GIT } from './ports/repository-git.js';

/**
 * `projects` business module: create and list projects (Story #16); the hardened Git
 * adapter (#59), not yet used by any feature. On Linux, start-up checks the Git version.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [CreateProjectEndpoint, ListProjectsEndpoint],
  providers: [
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
    {
      provide: REPOSITORY_GIT,
      useFactory: (config: AppConfig) => new SystemGitAdapter(systemGitSettings(config)),
      inject: [APP_CONFIG],
    },
    CreateProjectHandler,
    ListProjectsHandler,
  ],
})
export class ProjectsModule {}
