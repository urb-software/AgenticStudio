import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { SecretsModule } from '../../platform/secrets/secrets.module.js';
import { RUN_ENVIRONMENT_FILES, RUN_START_POINTS } from './contracts/index.js';
import { ENVIRONMENT_FILE_REPOSITORY } from './domain/repositories/environment-file-repository.js';
import { PROJECT_REPOSITORY } from './domain/repositories/project-repository.js';
import { REPOSITORY_CONNECTION_REPOSITORY } from './domain/repositories/repository-connection-repository.js';
import { CloneRepositoryHandler } from './application/features/clone-repository/handler.js';
import { ConnectRepositoryEndpoint } from './entry-points/http/operator/connect-repository/endpoint.js';
import {
  CONNECT_REPOSITORY_SETTINGS,
  ConnectRepositoryHandler,
  type ConnectRepositorySettings,
} from './application/features/connect-repository/handler.js';
import { DisconnectRepositoryEndpoint } from './entry-points/http/operator/disconnect-repository/endpoint.js';
import { DisconnectRepositoryHandler } from './application/features/disconnect-repository/handler.js';
import { ResumeDisconnectsHandler } from './application/features/resume-disconnects/handler.js';
import { RepositoryCleanup } from './application/repository-cleanup.js';
import { FetchRepositoryEndpoint } from './entry-points/http/operator/fetch-repository/endpoint.js';
import { FetchRepositoryHandler } from './application/features/fetch-repository/handler.js';
import { CreateProjectEndpoint } from './entry-points/http/operator/create-project/endpoint.js';
import { CreateProjectHandler } from './application/features/create-project/handler.js';
import { GetProjectEndpoint } from './entry-points/http/operator/get-project/endpoint.js';
import { GetProjectHandler } from './application/features/get-project/handler.js';
import { GetRepositoryEndpoint } from './entry-points/http/operator/get-repository/endpoint.js';
import { GetRepositoryHandler } from './application/features/get-repository/handler.js';
import { GetEnvironmentFileEndpoint } from './entry-points/http/operator/get-environment-file/endpoint.js';
import { GetEnvironmentFileHandler } from './application/features/get-environment-file/handler.js';
import { GetRunEnvironmentFileHandler } from './application/features/get-run-environment-file/handler.js';
import { RemoveEnvironmentFileEndpoint } from './entry-points/http/operator/remove-environment-file/endpoint.js';
import { RemoveEnvironmentFileHandler } from './application/features/remove-environment-file/handler.js';
import { SetEnvironmentFileEndpoint } from './entry-points/http/operator/set-environment-file/endpoint.js';
import { SetEnvironmentFileHandler } from './application/features/set-environment-file/handler.js';
import { SweepOrphanedEnvironmentFilesHandler } from './application/features/sweep-orphaned-environment-files/handler.js';
import { GetRunStartPointHandler } from './application/features/get-run-start-point/handler.js';
import { ListProjectsEndpoint } from './entry-points/http/operator/list-projects/endpoint.js';
import { ListProjectsHandler } from './application/features/list-projects/handler.js';
import { FetchCloneHandler } from './application/features/fetch-clone/handler.js';
import { RecordUnfinishedCloneHandler } from './application/features/record-unfinished-clone/handler.js';
import { RecordUnfinishedFetchHandler } from './application/features/record-unfinished-fetch/handler.js';
import { FailInterruptedClonesHandler } from './application/features/fail-interrupted-clones/handler.js';
import { FailInterruptedFetchesHandler } from './application/features/fail-interrupted-fetches/handler.js';
import { GetRepositoryOperationHandler } from './application/features/get-repository-operation/handler.js';
import { RepositoryJobProcessor } from './entry-points/jobs/repository-job-processor.js';
import { RepositoryStartupRecovery } from './entry-points/startup/repository-startup-recovery.js';
import { QueueRepositoryJobs } from './infrastructure/adapters/queue-repository-jobs.js';
import { SweepOrphanedDeployKeysHandler } from './application/features/sweep-orphaned-deploy-keys/handler.js';
import { VerifyRepositoryEndpoint } from './entry-points/http/operator/verify-repository/endpoint.js';
import { VerifyRepositoryHandler } from './application/features/verify-repository/handler.js';
import {
  SystemGitAdapter,
  type SystemGitSettings,
  systemGitSettings,
} from './infrastructure/adapters/git/system-git-adapter.js';
import { PrismaProjectRepository } from './infrastructure/repositories/prisma-project-repository.js';
import { PrismaRepositoryConnectionRepository } from './infrastructure/repositories/prisma-repository-connection-repository.js';
import { SecretStoreEnvironmentFileContents } from './infrastructure/adapters/secret-store-environment-file-contents.js';
import { ENVIRONMENT_FILE_CONTENTS } from './application/ports/environment-file-contents.js';
import { PrismaEnvironmentFileRepository } from './infrastructure/repositories/prisma-environment-file-repository.js';
import { REPOSITORY_JOBS } from './application/ports/repository-jobs.js';
import { REPOSITORY_GIT } from './application/ports/repository-git.js';
import {
  DEPLOY_KEY_SWEEP_SETTINGS,
  DEPLOY_KEYS,
  type DeployKeySweepSettings,
} from './application/ports/deploy-keys.js';
import {
  SecretStoreDeployKeys,
  SSH_TRUST_SETTINGS,
  type SshTrustSettings,
} from './infrastructure/adapters/secret-store-deploy-keys.js';
import { DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS } from './domain/value-objects/deploy-key-sweep-policy.js';

const REPOSITORY_JOB_ROUTING = Symbol('REPOSITORY_JOB_ROUTING');

/**
 * Test seam: shorter Git limits or another platform; production passes nothing. `platform` can
 * only make the Linux-only guard refuse more (security.md §4); see backend.md, "Test seam".
 */
export interface ProjectsModuleOptions {
  gitSettings?: Partial<
    Pick<
      SystemGitSettings,
      'cloneTimeoutMs' | 'fetchTimeoutMs' | 'maxCloneBytes' | 'sizePollIntervalMs' | 'platform'
    >
  >;
  deployKeySweep?: Partial<DeployKeySweepSettings>;
}

/**
 * `projects` business module: projects, their Repository (Git adapter, background jobs) and
 * Environment file. Other modules reach it through {@link RUN_START_POINTS} and {@link RUN_ENVIRONMENT_FILES}.
 */
@Module({})
export class ProjectsModule {
  static register(options: ProjectsModuleOptions = {}): DynamicModule {
    return {
      module: ProjectsModule,
      imports: [DatabaseModule, SecretsModule],
      controllers: [
        CreateProjectEndpoint,
        ListProjectsEndpoint,
        GetProjectEndpoint,
        GetRepositoryEndpoint,
        ConnectRepositoryEndpoint,
        FetchRepositoryEndpoint,
        DisconnectRepositoryEndpoint,
        VerifyRepositoryEndpoint,
        GetEnvironmentFileEndpoint,
        SetEnvironmentFileEndpoint,
        RemoveEnvironmentFileEndpoint,
      ],
      providers: [
        { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
        {
          provide: REPOSITORY_CONNECTION_REPOSITORY,
          useClass: PrismaRepositoryConnectionRepository,
        },
        { provide: ENVIRONMENT_FILE_REPOSITORY, useClass: PrismaEnvironmentFileRepository },
        { provide: ENVIRONMENT_FILE_CONTENTS, useClass: SecretStoreEnvironmentFileContents },
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
            allowPrivateRemotes: config.gitAllowPrivateRemotes,
          }),
          inject: [APP_CONFIG],
        },
        {
          provide: SSH_TRUST_SETTINGS,
          useFactory: (config: AppConfig): SshTrustSettings => ({
            knownHosts: config.sshKnownHosts,
          }),
          inject: [APP_CONFIG],
        },
        {
          provide: DEPLOY_KEY_SWEEP_SETTINGS,
          useValue: {
            gracePeriodMs:
              options.deployKeySweep?.gracePeriodMs ?? DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
          } satisfies DeployKeySweepSettings,
        },
        { provide: DEPLOY_KEYS, useClass: SecretStoreDeployKeys },
        SweepOrphanedDeployKeysHandler,
        CloneRepositoryHandler,
        FetchCloneHandler,
        RecordUnfinishedCloneHandler,
        RecordUnfinishedFetchHandler,
        FailInterruptedClonesHandler,
        FailInterruptedFetchesHandler,
        GetRepositoryOperationHandler,
        RepositoryStartupRecovery,
        RepositoryJobProcessor,
        QueueRepositoryJobs,
        { provide: REPOSITORY_JOBS, useExisting: QueueRepositoryJobs },
        // The queue adapter registers the queue; the job processor receives its events. A call
        // after construction, because the processor's handlers (Disconnect) use the adapter.
        {
          provide: REPOSITORY_JOB_ROUTING,
          useFactory: (jobs: QueueRepositoryJobs, processor: RepositoryJobProcessor) =>
            jobs.deliverTo(processor),
          inject: [QueueRepositoryJobs, RepositoryJobProcessor],
        },
        CreateProjectHandler,
        ListProjectsHandler,
        GetProjectHandler,
        GetRepositoryHandler,
        ConnectRepositoryHandler,
        FetchRepositoryHandler,
        RepositoryCleanup,
        DisconnectRepositoryHandler,
        ResumeDisconnectsHandler,
        VerifyRepositoryHandler,
        GetRunStartPointHandler,
        { provide: RUN_START_POINTS, useExisting: GetRunStartPointHandler },
        GetEnvironmentFileHandler,
        SetEnvironmentFileHandler,
        RemoveEnvironmentFileHandler,
        SweepOrphanedEnvironmentFilesHandler,
        GetRunEnvironmentFileHandler,
        { provide: RUN_ENVIRONMENT_FILES, useExisting: GetRunEnvironmentFileHandler },
      ],
      exports: [RUN_START_POINTS, RUN_ENVIRONMENT_FILES],
    };
  }
}
