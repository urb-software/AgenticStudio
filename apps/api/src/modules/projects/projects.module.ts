import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { SecretsModule } from '../../platform/secrets/secrets.module.js';
import { RUN_ENVIRONMENT_FILES, RUN_START_POINTS } from './contracts/index.js';
import { ENVIRONMENT_FILE_REPOSITORY } from './domain/repositories/environment-file-repository.js';
import { PROJECT_REPOSITORY } from './domain/repositories/project-repository.js';
import { CloneRepositoryHandler } from './application/features/clone-repository/handler.js';
import { ConnectRepositoryEndpoint } from './entry-points/http/operator/connect-repository/endpoint.js';
import {
  CONNECT_REPOSITORY_SETTINGS,
  ConnectRepositoryHandler,
  type ConnectRepositorySettings,
} from './application/features/connect-repository/handler.js';
import { DisconnectRepositoryEndpoint } from './entry-points/http/operator/disconnect-repository/endpoint.js';
import { DisconnectRepositoryHandler } from './application/features/disconnect-repository/handler.js';
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

/** DI token of the wiring that connects the repository queue's adapter to its job processor. */
const REPOSITORY_JOB_ROUTING = Symbol('REPOSITORY_JOB_ROUTING');

/**
 * Test seam of the module (like the job queue's worker tuning): tests pass shorter Git limits
 * or another platform. Production passes nothing, so the adapter keeps the pinned production
 * settings (`systemGitSettings`).
 *
 * Why `platform` stays here (#72): the HTTP suites build the real app (`AppModule.register`)
 * and need a non-Linux API host on the Linux CI runner to prove the 501 path end to end. Only
 * code can set it (no configuration or environment variable reaches it), `main.ts` passes no
 * options, and it can only make the Linux-only guard refuse more: on a host that is not Linux
 * the adapter refuses whatever it says, since Git operations need Linux anyway (security.md
 * §4). A provider override would need a second way to build the app for those suites alone.
 */
export interface ProjectsModuleOptions {
  gitSettings?: Partial<
    Pick<
      SystemGitSettings,
      'cloneTimeoutMs' | 'fetchTimeoutMs' | 'maxCloneBytes' | 'sizePollIntervalMs' | 'platform'
    >
  >;
  /** A shorter grace period for the orphaned Deploy-key sweep (Issue #76). */
  deployKeySweep?: Partial<DeployKeySweepSettings>;
}

/**
 * `projects` business module: create and list projects (Story #16); the project detail and
 * connecting a public repository over HTTPS with a background clone (Story #60), or a private
 * one over SSH with a generated Deploy key (Story #62), fetching it on demand (Story #61) and
 * disconnecting it (Story #63), through the hardened Git adapter (#59). On Linux, start-up checks
 * the Git version and sweeps crash leftovers (`onModuleInit`) before the repository worker
 * starts (after bootstrap). Deploy keys no Repository references are deleted at start-up and
 * after a failed delete (Issue #76). Other modules get a Run's start point through the public
 * {@link RUN_START_POINTS} contract (Issue #96). Each project may have one Environment file
 * (Issue #104), its content in the secret store; `executions` reads it when a Run is claimed
 * through the public {@link RUN_ENVIRONMENT_FILES} contract.
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
        DisconnectRepositoryHandler,
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
