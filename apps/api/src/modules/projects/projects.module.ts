import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { PROJECT_REPOSITORY } from './domain/repositories/project-repository.js';
import { CloneRepositoryHandler } from './features/clone-repository/handler.js';
import { ConnectRepositoryEndpoint } from './features/connect-repository/endpoint.js';
import {
  CONNECT_REPOSITORY_SETTINGS,
  ConnectRepositoryHandler,
  type ConnectRepositorySettings,
} from './features/connect-repository/handler.js';
import { FetchRepositoryEndpoint } from './features/fetch-repository/endpoint.js';
import { FetchRepositoryHandler } from './features/fetch-repository/handler.js';
import { CreateProjectEndpoint } from './features/create-project/endpoint.js';
import { CreateProjectHandler } from './features/create-project/handler.js';
import { GetProjectEndpoint } from './features/get-project/endpoint.js';
import { GetProjectHandler } from './features/get-project/handler.js';
import { GetRepositoryEndpoint } from './features/get-repository/endpoint.js';
import { GetRepositoryHandler } from './features/get-repository/handler.js';
import { ListProjectsEndpoint } from './features/list-projects/endpoint.js';
import { ListProjectsHandler } from './features/list-projects/handler.js';
import {
  SystemGitAdapter,
  type SystemGitSettings,
  systemGitSettings,
} from './infrastructure/adapters/git/system-git-adapter.js';
import { PrismaProjectRepository } from './infrastructure/repositories/prisma-project-repository.js';
import { CLONE_JOBS } from './ports/clone-jobs.js';
import { REPOSITORY_GIT } from './ports/repository-git.js';

/**
 * Test seam of the module (like the job queue's worker tuning): tests pass shorter Git limits
 * or another platform. Production passes nothing, so the adapter keeps the pinned production
 * settings (`systemGitSettings`).
 */
export interface ProjectsModuleOptions {
  gitSettings?: Partial<
    Pick<
      SystemGitSettings,
      'cloneTimeoutMs' | 'fetchTimeoutMs' | 'maxCloneBytes' | 'sizePollIntervalMs' | 'platform'
    >
  >;
}

/**
 * `projects` business module: create and list projects (Story #16); the project detail and
 * connecting a public repository over HTTPS with a background clone (Story #60), through the
 * hardened Git adapter (#59). On Linux, start-up checks the Git version and sweeps crash
 * leftovers (`onModuleInit`) before the clone worker starts (after bootstrap).
 */
@Module({})
export class ProjectsModule {
  static register(options: ProjectsModuleOptions = {}): DynamicModule {
    return {
      module: ProjectsModule,
      imports: [DatabaseModule],
      controllers: [
        CreateProjectEndpoint,
        ListProjectsEndpoint,
        GetProjectEndpoint,
        GetRepositoryEndpoint,
        ConnectRepositoryEndpoint,
        FetchRepositoryEndpoint,
      ],
      providers: [
        { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
        {
          provide: REPOSITORY_GIT,
          useFactory: (config: AppConfig) =>
            new SystemGitAdapter({ ...systemGitSettings(config), ...options.gitSettings }),
          inject: [APP_CONFIG],
        },
        {
          provide: CONNECT_REPOSITORY_SETTINGS,
          useFactory: (config: AppConfig): ConnectRepositorySettings => ({
            allowFileRemotes: config.gitAllowFileRemotes,
          }),
          inject: [APP_CONFIG],
        },
        CloneRepositoryHandler,
        { provide: CLONE_JOBS, useExisting: CloneRepositoryHandler },
        CreateProjectHandler,
        ListProjectsHandler,
        GetProjectHandler,
        GetRepositoryHandler,
        ConnectRepositoryHandler,
        FetchRepositoryHandler,
      ],
    };
  }
}
