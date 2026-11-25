import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { SecretsModule } from '../../platform/secrets/secrets.module.js';
import {
  DEFINITIONS_FILES,
  DEFINITIONS_PUBLISH,
  DEFINITIONS_REPOSITORIES,
  PROJECT_KINDS,
  RUN_BRANCH_REVIEWS,
  RUN_ENVIRONMENT_FILES,
  RUN_INTEGRATION_FETCHES,
  PROJECT_DEFAULT_AGENTS,
  RUN_MERGE_METHODS,
  REPOSITORY_DISCONNECT_STEPS,
  RUN_PREVIEW_SOURCES,
  RUN_START_POINTS,
} from './contracts/index.js';
import { GetDefinitionsRepositoryStateHandler } from './application/features/get-definitions-repository-state/handler.js';
import { ListDefinitionsTreeHandler } from './application/features/list-definitions-tree/handler.js';
import { ReadDefinitionsBlobIdsHandler } from './application/features/read-definitions-blob-ids/handler.js';
import { ReadDefinitionsBlobsHandler } from './application/features/read-definitions-blobs/handler.js';
import { ReadDefinitionsFilesHandler } from './application/features/read-definitions-files/handler.js';
import { ProjectDefinitionsFiles } from './entry-points/contracts/definitions-files.js';
import { ProjectDefinitionsPublish } from './entry-points/contracts/definitions-publish.js';
import { ProjectDefinitionsRepositories } from './entry-points/contracts/definitions-repositories.js';
import { PublishDefinitionsHandler } from './application/features/publish-definitions/handler.js';
import { GetDefinitionsProjectIdHandler } from './application/features/get-definitions-project-id/handler.js';
import { GetProjectKindHandler } from './application/features/get-project-kind/handler.js';
import { ProjectProjectKinds } from './entry-points/contracts/project-kinds.js';
import { GetProjectNamesHandler } from './application/features/get-project-names/handler.js';
import { ProjectRepositoryDisconnectSteps } from './entry-points/contracts/repository-disconnect-steps.js';
import {
  REPOSITORY_DISCONNECTS_SETTINGS,
  RepositoryDisconnectsScheduler,
  type RepositoryDisconnectsSettings,
} from './entry-points/schedulers/repository-disconnects.js';
import { GetPreviewSourceStatusHandler } from './application/features/get-preview-source-status/handler.js';
import { OpenPreviewArchiveHandler } from './application/features/open-preview-archive/handler.js';
import { ReadIntegrationFileHandler } from './application/features/read-integration-file/handler.js';
import { ProjectRunPreviewSources } from './entry-points/contracts/run-preview-sources.js';
import { ProjectRunIntegrationFetches } from './entry-points/contracts/run-integration-fetches.js';
import { ENVIRONMENT_FILE_REPOSITORY } from './domain/repositories/environment-file-repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from './domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from './domain/repositories/repository-connection-repository.js';
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
import { SetDefaultAgentEndpoint } from './entry-points/http/operator/set-default-agent/endpoint.js';
import { SetDefaultAgentHandler } from './application/features/set-default-agent/handler.js';
import { GetProjectDefaultAgentHandler } from './application/features/get-project-default-agent/handler.js';
import { ProjectProjectDefaultAgents } from './entry-points/contracts/project-default-agents.js';
import { SetMergeMethodEndpoint } from './entry-points/http/operator/set-merge-method/endpoint.js';
import { SetMergeMethodHandler } from './application/features/set-merge-method/handler.js';
import { GetRunMergeMethodHandler } from './application/features/get-run-merge-method/handler.js';
import { SweepOrphanedEnvironmentFilesHandler } from './application/features/sweep-orphaned-environment-files/handler.js';
import { ProjectRunEnvironmentFiles } from './entry-points/contracts/run-environment-files.js';
import { ProjectRunMergeMethods } from './entry-points/contracts/run-merge-methods.js';
import { ProjectRunBranchReviews } from './entry-points/contracts/run-branch-reviews.js';
import { ProjectRunStartPoints } from './entry-points/contracts/run-start-points.js';
import { FetchForReviewHandler } from './application/features/fetch-for-review/handler.js';
import { MergeDiffHandler } from './application/features/merge-diff/handler.js';
import { GetReviewSupportHandler } from './application/features/get-review-support/handler.js';
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
  /** `false` leaves the periodic retry of disconnecting Repositories off. */
  disconnectRetries?: boolean;
  /** Milliseconds between those retries; 30 seconds when unset. */
  disconnectRetryMs?: number;
}

/** How often a disconnecting Repository's cleanup is retried. */
const DISCONNECT_RETRY_MS = 30_000;

/**
 * `projects` business module: projects, their Repository (Git adapter, background jobs),
 * Environment file and merge method. Other modules reach it through the symbols that its
 * `contracts/` exports, such as `PROJECT_KINDS` and `RUN_START_POINTS`.
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
        SetMergeMethodEndpoint,
        SetDefaultAgentEndpoint,
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
          useFactory: (
            config: AppConfig,
            definitions: GetDefinitionsProjectIdHandler,
            projects: ProjectRepository,
            repositories: RepositoryConnectionRepository,
          ) =>
            new SystemGitAdapter({
              ...systemGitSettings(config),
              ...options.gitSettings,
              // The adapter reads the kind itself before it writes: only the definitions Project.
              definitionsProjectId: () => definitions.execute(),
              definitionsRemoteUrl: async () => {
                const project = await projects.findDefinitions();
                return project ? ((await repositories.find(project.id))?.url ?? null) : null;
              },
            }),
          inject: [
            APP_CONFIG,
            GetDefinitionsProjectIdHandler,
            PROJECT_REPOSITORY,
            REPOSITORY_CONNECTION_REPOSITORY,
          ],
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
        { provide: REPOSITORY_DISCONNECT_STEPS, useClass: ProjectRepositoryDisconnectSteps },
        RepositoryCleanup,
        DisconnectRepositoryHandler,
        ResumeDisconnectsHandler,
        {
          provide: REPOSITORY_DISCONNECTS_SETTINGS,
          useValue: {
            enabled: options.disconnectRetries !== false,
            intervalMs: options.disconnectRetryMs ?? DISCONNECT_RETRY_MS,
          } satisfies RepositoryDisconnectsSettings,
        },
        RepositoryDisconnectsScheduler,
        VerifyRepositoryHandler,
        GetRunStartPointHandler,
        { provide: RUN_START_POINTS, useClass: ProjectRunStartPoints },
        GetEnvironmentFileHandler,
        SetEnvironmentFileHandler,
        RemoveEnvironmentFileHandler,
        SweepOrphanedEnvironmentFilesHandler,
        GetRunEnvironmentFileHandler,
        { provide: RUN_ENVIRONMENT_FILES, useClass: ProjectRunEnvironmentFiles },
        FetchForReviewHandler,
        MergeDiffHandler,
        GetReviewSupportHandler,
        { provide: RUN_BRANCH_REVIEWS, useClass: ProjectRunBranchReviews },
        { provide: RUN_INTEGRATION_FETCHES, useClass: ProjectRunIntegrationFetches },
        SetMergeMethodHandler,
        GetRunMergeMethodHandler,
        { provide: RUN_MERGE_METHODS, useClass: ProjectRunMergeMethods },
        SetDefaultAgentHandler,
        GetProjectDefaultAgentHandler,
        { provide: PROJECT_DEFAULT_AGENTS, useClass: ProjectProjectDefaultAgents },
        GetPreviewSourceStatusHandler,
        ReadIntegrationFileHandler,
        OpenPreviewArchiveHandler,
        GetProjectNamesHandler,
        GetProjectKindHandler,
        GetDefinitionsProjectIdHandler,
        GetDefinitionsRepositoryStateHandler,
        { provide: DEFINITIONS_REPOSITORIES, useClass: ProjectDefinitionsRepositories },
        ListDefinitionsTreeHandler,
        ReadDefinitionsFilesHandler,
        ReadDefinitionsBlobsHandler,
        ReadDefinitionsBlobIdsHandler,
        { provide: DEFINITIONS_FILES, useClass: ProjectDefinitionsFiles },
        PublishDefinitionsHandler,
        { provide: DEFINITIONS_PUBLISH, useClass: ProjectDefinitionsPublish },
        { provide: PROJECT_KINDS, useClass: ProjectProjectKinds },
        { provide: RUN_PREVIEW_SOURCES, useClass: ProjectRunPreviewSources },
      ],
      exports: [
        PROJECT_KINDS,
        DEFINITIONS_REPOSITORIES,
        DEFINITIONS_FILES,
        DEFINITIONS_PUBLISH,
        RUN_START_POINTS,
        RUN_ENVIRONMENT_FILES,
        RUN_BRANCH_REVIEWS,
        RUN_INTEGRATION_FETCHES,
        RUN_MERGE_METHODS,
        PROJECT_DEFAULT_AGENTS,
        RUN_PREVIEW_SOURCES,
        REPOSITORY_DISCONNECT_STEPS,
      ],
    };
  }
}
