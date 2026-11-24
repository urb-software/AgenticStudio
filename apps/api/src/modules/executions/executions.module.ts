import {
  RUN_DIFF_FILE_PATCH_MAX_BYTES,
  RUN_DIFF_FILES_MAX,
  RUN_DIFF_MAX_BYTES,
  RUN_DIFF_PATCH_MAX_BYTES,
} from '@agentic-studio/contracts';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { AuthModule } from '../../platform/auth/auth.module.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { SecretsModule } from '../../platform/secrets/secrets.module.js';
import { RUN_DIFF_REPOSITORY } from './domain/repositories/run-diff-repository.js';
import { PREPARED_FOLLOW_UP_REPOSITORY } from './domain/repositories/prepared-follow-up-repository.js';
import { REVIEW_COMMENT_REPOSITORY } from './domain/repositories/review-comment-repository.js';
import { RUN_LOOKUP_REPOSITORY } from './domain/repositories/run-lookup-repository.js';
import { RUN_REPOSITORY } from './domain/repositories/run-repository.js';
import { RUN_MERGE_REVIEW_REPOSITORY } from './domain/repositories/run-merge-review-repository.js';
import { GetMergeReviewEndpoint } from './entry-points/http/operator/get-merge-review/endpoint.js';
import { GetMergeReviewHandler } from './application/features/get-merge-review/handler.js';
import { GetMergeReviewFileHandler } from './application/features/get-merge-review-file/handler.js';
import { PrepareMergeReviewHandler } from './application/features/prepare-merge-review/handler.js';
import { RequestMergeReviewEndpoint } from './entry-points/http/operator/request-merge-review/endpoint.js';
import { RequestMergeReviewHandler } from './application/features/request-merge-review/handler.js';
import { MERGE_APPROVAL_REPOSITORY } from './domain/repositories/merge-approval-repository.js';
import { PrismaMergeApprovalRepository } from './infrastructure/repositories/prisma-merge-approval-repository.js';
import { PrismaRunMergeReviewRepository } from './infrastructure/repositories/prisma-run-merge-review-repository.js';
import { AnswerRunEndpoint } from './entry-points/http/operator/answer-run/endpoint.js';
import { AnswerRunHandler } from './application/features/answer-run/handler.js';
import { CancelLongWaitingRunsHandler } from './application/features/cancel-long-waiting-runs/handler.js';
import { ClosePullRequestEndpoint } from './entry-points/http/operator/close-pull-request/endpoint.js';
import { MergeRunEndpoint } from './entry-points/http/operator/merge-run/endpoint.js';
import { MergeRunHandler } from './application/features/merge-run/handler.js';
import { ClosePullRequestHandler } from './application/features/close-pull-request/handler.js';
import { CancelRunEndpoint } from './entry-points/http/operator/cancel-run/endpoint.js';
import { CancelRunHandler } from './application/features/cancel-run/handler.js';
import { AppendRunEventsEndpoint } from './entry-points/http/agent-worker/append-run-events/endpoint.js';
import { AppendRunEventsHandler } from './application/features/append-run-events/handler.js';
import { ClaimLookupsEndpoint } from './entry-points/http/agent-worker/claim-lookups/endpoint.js';
import { ClaimLookupsHandler } from './application/features/claim-lookups/handler.js';
import { ClaimRunEndpoint } from './entry-points/http/agent-worker/claim-run/endpoint.js';
import { ClaimRunHandler } from './application/features/claim-run/handler.js';
import { GetRunEndpoint } from './entry-points/http/operator/get-run/endpoint.js';
import { GetRunsSummaryEndpoint } from './entry-points/http/operator/get-runs-summary/endpoint.js';
import { GetRunsSummaryHandler } from './application/features/get-runs-summary/handler.js';
import { GetRunHandler } from './application/features/get-run/handler.js';
import { GetRunDiffEndpoint } from './entry-points/http/operator/get-run-diff/endpoint.js';
import { GetRunDiffHandler } from './application/features/get-run-diff/handler.js';
import { GetRunDiffFileHandler } from './application/features/get-run-diff-file/handler.js';
import { ListRunEventsEndpoint } from './entry-points/http/operator/list-run-events/endpoint.js';
import { ListRunEventsHandler } from './application/features/list-run-events/handler.js';
import { ListRunStepsEndpoint } from './entry-points/http/operator/list-run-steps/endpoint.js';
import { ListRunStepsHandler } from './application/features/list-run-steps/handler.js';
import { GetAgentWorkerEndpoint } from './entry-points/http/operator/get-agent-worker/endpoint.js';
import { GetAgentWorkerHandler } from './application/features/get-agent-worker/handler.js';
import { GetRunStatesEndpoint } from './entry-points/http/agent-worker/get-run-states/endpoint.js';
import { GetRunStatesHandler } from './application/features/get-run-states/handler.js';
import { ListProvidersEndpoint } from './entry-points/http/operator/list-providers/endpoint.js';
import { ListProvidersHandler } from './application/features/list-providers/handler.js';
import { ListProjectRunsEndpoint } from './entry-points/http/operator/list-project-runs/endpoint.js';
import { ListProjectRunsHandler } from './application/features/list-project-runs/handler.js';
import { ListRunsEndpoint } from './entry-points/http/operator/list-runs/endpoint.js';
import { ListRunsHandler } from './application/features/list-runs/handler.js';
import { RecordHeartbeatEndpoint } from './entry-points/http/agent-worker/record-heartbeat/endpoint.js';
import { DiscardPreparedFollowUpEndpoint } from './entry-points/http/operator/discard-prepared-follow-up/endpoint.js';
import { DiscardPreparedFollowUpHandler } from './application/features/discard-prepared-follow-up/handler.js';
import { GetPreparedFollowUpEndpoint } from './entry-points/http/operator/get-prepared-follow-up/endpoint.js';
import { GetReviewCommentsEndpoint } from './entry-points/http/operator/get-review-comments/endpoint.js';
import { GetReviewCommentsHandler } from './application/features/get-review-comments/handler.js';
import { LoadReviewCommentsEndpoint } from './entry-points/http/operator/load-review-comments/endpoint.js';
import { LoadReviewCommentsHandler } from './application/features/load-review-comments/handler.js';
import { GetPreparedFollowUpHandler } from './application/features/get-prepared-follow-up/handler.js';
import { PrepareFailingChecksEndpoint } from './entry-points/http/operator/prepare-failing-checks/endpoint.js';
import { PrepareFailingChecksHandler } from './application/features/prepare-failing-checks/handler.js';
import { RefreshPullRequestEndpoint } from './entry-points/http/operator/refresh-pull-request/endpoint.js';
import { RefreshPullRequestHandler } from './application/features/refresh-pull-request/handler.js';
import { ReportLookupResultEndpoint } from './entry-points/http/agent-worker/report-lookup-result/endpoint.js';
import { ReportLookupResultHandler } from './application/features/report-lookup-result/handler.js';
import { RecordHeartbeatHandler } from './application/features/record-heartbeat/handler.js';
import { ReportRunDiffEndpoint } from './entry-points/http/agent-worker/report-run-diff/endpoint.js';
import { ReportRunDiffHandler } from './application/features/report-run-diff/handler.js';
import { ReportRunStateEndpoint } from './entry-points/http/agent-worker/report-run-state/endpoint.js';
import { ReportRunStateHandler } from './application/features/report-run-state/handler.js';
import { ReportRunStepEndpoint } from './entry-points/http/agent-worker/report-run-step/endpoint.js';
import { ReportRunStepHandler } from './application/features/report-run-step/handler.js';
import { ReportWorkerStatusEndpoint } from './entry-points/http/agent-worker/report-worker-status/endpoint.js';
import { ReportWorkerStatusHandler } from './application/features/report-worker-status/handler.js';
import { RequestDailyPullRequestRefreshesHandler } from './application/features/request-daily-pull-request-refreshes/handler.js';
import {
  DAILY_PULL_REQUEST_REFRESH_SETTINGS,
  DAILY_REFRESH_INTERVAL_MS,
  DailyPullRequestRefreshScheduler,
  type DailyPullRequestRefreshSettings,
} from './entry-points/schedulers/daily-pull-request-refresh.js';
import {
  RUN_SWEEPS_SETTINGS,
  RunSweepsScheduler,
  type RunSweepsSettings,
} from './entry-points/schedulers/run-sweeps.js';
import { ReleaseFinalSnapshotsHandler } from './application/features/release-final-snapshots/handler.js';
import { RenewHeldRunLeasesHandler } from './application/features/renew-held-run-leases/handler.js';
import { TimeOutOverdueStepsHandler } from './application/features/time-out-overdue-steps/handler.js';
import { RetryDeliveryEndpoint } from './entry-points/http/operator/retry-delivery/endpoint.js';
import { RetryDeliveryHandler } from './application/features/retry-delivery/handler.js';
import { BringUpToDateEndpoint } from './entry-points/http/operator/bring-up-to-date/endpoint.js';
import { FollowUpRunEndpoint } from './entry-points/http/operator/follow-up-run/endpoint.js';
import { FollowUpRunHandler } from './application/features/follow-up-run/handler.js';
import { ResumeRunEndpoint } from './entry-points/http/operator/resume-run/endpoint.js';
import { ResumeRunHandler } from './application/features/resume-run/handler.js';
import { StartRunEndpoint } from './entry-points/http/operator/start-run/endpoint.js';
import { StartRunHandler } from './application/features/start-run/handler.js';
import { StreamRunEventsEndpoint } from './entry-points/http/operator/stream-run-events/endpoint.js';
import { StreamRunEventsHandler } from './application/features/stream-run-events/handler.js';
import { LogStreamSlots } from './application/features/stream-run-events/log-stream-slots.js';
import { StreamSession } from './application/features/stream-run-events/stream-session.js';
import { SweepLostWorkersHandler } from './application/features/sweep-lost-workers/handler.js';
import { EnvironmentFileSecretValues } from './infrastructure/adapters/environment-file-secret-values.js';
import { SecretStoreEnvironmentFileSnapshots } from './infrastructure/adapters/environment-file-snapshots.js';
import {
  ENVIRONMENT_FILE_SNAPSHOTS,
  RUN_SNAPSHOT_SETTINGS,
  type RunSnapshotSettings,
} from './application/ports/environment-file-snapshots.js';
import { GitHubMergeHost } from './infrastructure/adapters/github-merge-host.js';
import { InProcessRunLogSignal } from './infrastructure/adapters/in-process-run-log-signal.js';
import { PlatformOperatorSessions } from './infrastructure/adapters/platform-operator-sessions.js';
import { PrismaRunDiffRepository } from './infrastructure/repositories/prisma-run-diff-repository.js';
import { PrismaRunLog } from './infrastructure/repositories/prisma-run-log.js';
import { PrismaRunTransactions } from './infrastructure/adapters/prisma-run-transactions.js';
import { PrismaPreparedFollowUpRepository } from './infrastructure/repositories/prisma-prepared-follow-up-repository.js';
import { PrismaReviewCommentRepository } from './infrastructure/repositories/prisma-review-comment-repository.js';
import { PrismaRunLookupRepository } from './infrastructure/repositories/prisma-run-lookup-repository.js';
import { InMemoryWorkerStatusStore } from './infrastructure/adapters/in-memory-worker-status-store.js';
import { PrismaRunRepository } from './infrastructure/repositories/prisma-run-repository.js';
import { CLOCK, type Clock } from './application/ports/clock.js';
import { OPERATOR_LOGIN, type OperatorLogin } from './application/ports/operator-login.js';
import { RUN_LIMITS, type RunLimitsSetting } from './application/ports/run-limits.js';
import {
  MERGE_REVIEW_LIMITS,
  type MergeReviewLimitsSetting,
} from './application/ports/merge-review-limits.js';
import { OPERATOR_SESSIONS } from './application/ports/operator-sessions.js';
import { MERGE_HOST, type MergeHost } from './application/ports/merge-host.js';
import { MERGE_SETTINGS, type MergeSettings } from './application/ports/merge-settings.js';
import { RUN_LOG_SETTINGS, type RunLogSettings } from './application/ports/run-log-settings.js';
import { RUN_LOG } from './application/ports/run-log.js';
import { RUN_LOG_SIGNAL } from './application/ports/run-log-signal.js';
import { RUN_TRANSACTIONS } from './application/ports/run-transactions.js';
import { RunLookupRequests } from './application/run-lookup-requests.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from './application/ports/run-secret-values.js';
import { RETENTION_POLICY } from './application/ports/retention-policy.js';
import { RetentionPolicy } from './domain/value-objects/retention-policy.js';
import { WORKER_LEASE, type WorkerLease } from './application/ports/worker-lease.js';
import { WORKER_STATUS_STORE } from './application/ports/worker-status-store.js';

/** Test seams: production passes nothing. */
export interface ExecutionsModuleOptions {
  clock?: Clock;
  logKeepAliveMs?: number;
  logStreamLimits?: { perSession: number; total: number };
  secretValues?: RunSecretValues;
  mergeHost?: MergeHost;
  pullRequestRefresh?: Pick<DailyPullRequestRefreshSettings, 'manual'>;
}

const SYSTEM_CLOCK: Clock = { now: () => new Date() };

const LOG_KEEP_ALIVE_MS = 15_000;

const LOG_STREAMS_PER_SESSION = 5;
const LOG_STREAMS_TOTAL = 50;

@Module({})
export class ExecutionsModule {
  static register(
    projects: DynamicModule,
    environments: DynamicModule,
    options: ExecutionsModuleOptions = {},
  ): DynamicModule {
    return {
      module: ExecutionsModule,
      imports: [DatabaseModule, AuthModule, SecretsModule, projects, environments],
      controllers: [
        StartRunEndpoint,
        ListProjectRunsEndpoint,
        ListRunsEndpoint,
        // Before GetRunEndpoint: `runs/:runId` would take `runs/summary`.
        GetRunsSummaryEndpoint,
        GetRunEndpoint,
        CancelRunEndpoint,
        RetryDeliveryEndpoint,
        AnswerRunEndpoint,
        ResumeRunEndpoint,
        FollowUpRunEndpoint,
        BringUpToDateEndpoint,
        RefreshPullRequestEndpoint,
        ClosePullRequestEndpoint,
        MergeRunEndpoint,
        PrepareFailingChecksEndpoint,
        GetPreparedFollowUpEndpoint,
        LoadReviewCommentsEndpoint,
        GetReviewCommentsEndpoint,
        DiscardPreparedFollowUpEndpoint,
        ClaimRunEndpoint,
        ClaimLookupsEndpoint,
        ReportLookupResultEndpoint,
        ReportRunStateEndpoint,
        ReportRunStepEndpoint,
        RecordHeartbeatEndpoint,
        AppendRunEventsEndpoint,
        ListRunEventsEndpoint,
        StreamRunEventsEndpoint,
        ListRunStepsEndpoint,
        GetRunDiffEndpoint,
        ReportRunDiffEndpoint,
        RequestMergeReviewEndpoint,
        GetMergeReviewEndpoint,
        GetRunStatesEndpoint,
        ReportWorkerStatusEndpoint,
        ListProvidersEndpoint,
        GetAgentWorkerEndpoint,
      ],
      providers: [
        { provide: RUN_REPOSITORY, useClass: PrismaRunRepository },
        { provide: RUN_LOG, useClass: PrismaRunLog },
        { provide: RUN_TRANSACTIONS, useClass: PrismaRunTransactions },
        RunLookupRequests,
        { provide: RUN_DIFF_REPOSITORY, useClass: PrismaRunDiffRepository },
        { provide: RUN_MERGE_REVIEW_REPOSITORY, useClass: PrismaRunMergeReviewRepository },
        { provide: MERGE_APPROVAL_REPOSITORY, useClass: PrismaMergeApprovalRepository },
        { provide: RUN_LOOKUP_REPOSITORY, useClass: PrismaRunLookupRepository },
        { provide: PREPARED_FOLLOW_UP_REPOSITORY, useClass: PrismaPreparedFollowUpRepository },
        { provide: REVIEW_COMMENT_REPOSITORY, useClass: PrismaReviewCommentRepository },
        { provide: RUN_LOG_SIGNAL, useClass: InProcessRunLogSignal },
        { provide: OPERATOR_SESSIONS, useClass: PlatformOperatorSessions },
        options.secretValues
          ? { provide: RUN_SECRET_VALUES, useValue: options.secretValues }
          : { provide: RUN_SECRET_VALUES, useClass: EnvironmentFileSecretValues },
        {
          provide: RUN_LOG_SETTINGS,
          useFactory: (config: AppConfig): RunLogSettings => ({
            maxBytes: config.runLogMaxBytes,
            keepAliveMs: options.logKeepAliveMs ?? LOG_KEEP_ALIVE_MS,
            streamsPerSession: options.logStreamLimits?.perSession ?? LOG_STREAMS_PER_SESSION,
            streamsTotal: options.logStreamLimits?.total ?? LOG_STREAMS_TOTAL,
          }),
          inject: [APP_CONFIG],
        },
        { provide: CLOCK, useValue: options.clock ?? SYSTEM_CLOCK },
        { provide: WORKER_STATUS_STORE, useClass: InMemoryWorkerStatusStore },
        {
          provide: WORKER_LEASE,
          useFactory: (config: AppConfig): WorkerLease => ({ seconds: config.workerLeaseSeconds }),
          inject: [APP_CONFIG],
        },
        {
          provide: RETENTION_POLICY,
          useFactory: (config: AppConfig): RetentionPolicy => RetentionPolicy.of(config.retention),
          inject: [APP_CONFIG],
        },
        {
          provide: OPERATOR_LOGIN,
          useFactory: (config: AppConfig): OperatorLogin => ({ login: config.operatorGithubLogin }),
          inject: [APP_CONFIG],
        },
        {
          provide: MERGE_SETTINGS,
          useFactory: (config: AppConfig): MergeSettings => ({
            configured: config.mergeCredential !== null,
            allowFileRemotes: config.gitAllowFileRemotes,
          }),
          inject: [APP_CONFIG],
        },
        // Only operator features may inject MERGE_HOST; a worker route never does.
        options.mergeHost
          ? { provide: MERGE_HOST, useValue: options.mergeHost }
          : {
              provide: MERGE_HOST,
              useFactory: (config: AppConfig): MergeHost =>
                new GitHubMergeHost({
                  credential: config.mergeCredential,
                  ...(config.mergeGithubApiUrl === null
                    ? {}
                    : { apiUrl: config.mergeGithubApiUrl }),
                  allowFileRemotes: config.gitAllowFileRemotes,
                }),
              inject: [APP_CONFIG],
            },
        {
          provide: RUN_LIMITS,
          useFactory: (config: AppConfig): RunLimitsSetting => ({ ...config.runLimits }),
          inject: [APP_CONFIG],
        },
        {
          provide: MERGE_REVIEW_LIMITS,
          useValue: {
            filesMax: RUN_DIFF_FILES_MAX,
            filePatchMaxBytes: RUN_DIFF_FILE_PATCH_MAX_BYTES,
            patchMaxBytes: RUN_DIFF_PATCH_MAX_BYTES,
            totalMaxBytes: RUN_DIFF_MAX_BYTES,
          } satisfies MergeReviewLimitsSetting,
        },
        StartRunHandler,
        ListProjectRunsHandler,
        ListRunsHandler,
        GetRunsSummaryHandler,
        GetRunHandler,
        CancelRunHandler,
        CancelLongWaitingRunsHandler,
        RetryDeliveryHandler,
        AnswerRunHandler,
        ResumeRunHandler,
        FollowUpRunHandler,
        RefreshPullRequestHandler,
        ClosePullRequestHandler,
        MergeRunHandler,
        PrepareFailingChecksHandler,
        GetPreparedFollowUpHandler,
        LoadReviewCommentsHandler,
        GetReviewCommentsHandler,
        DiscardPreparedFollowUpHandler,
        ClaimRunHandler,
        ClaimLookupsHandler,
        ReportLookupResultHandler,
        ReportRunStateHandler,
        ReportRunStepHandler,
        RecordHeartbeatHandler,
        AppendRunEventsHandler,
        ListRunEventsHandler,
        StreamRunEventsHandler,
        LogStreamSlots,
        StreamSession,
        ListRunStepsHandler,
        GetRunDiffHandler,
        GetRunDiffFileHandler,
        ReportRunDiffHandler,
        RequestMergeReviewHandler,
        PrepareMergeReviewHandler,
        GetMergeReviewHandler,
        GetMergeReviewFileHandler,
        GetRunStatesHandler,
        ReportWorkerStatusHandler,
        ListProvidersHandler,
        GetAgentWorkerHandler,
        SweepLostWorkersHandler,
        TimeOutOverdueStepsHandler,
        RenewHeldRunLeasesHandler,
        ReleaseFinalSnapshotsHandler,
        { provide: ENVIRONMENT_FILE_SNAPSHOTS, useClass: SecretStoreEnvironmentFileSnapshots },
        {
          provide: RUN_SNAPSHOT_SETTINGS,
          useFactory: (config: AppConfig): RunSnapshotSettings => ({
            retentionDays: config.runSnapshotRetentionDays,
          }),
          inject: [APP_CONFIG],
        },
        {
          provide: RUN_SWEEPS_SETTINGS,
          useFactory: (config: AppConfig): RunSweepsSettings => ({
            // Half the lease, at most every 30 s: a lost worker is noticed within half a lease
            // after its lease expires.
            intervalMs: Math.min(30_000, (config.workerLeaseSeconds * 1000) / 2),
          }),
          inject: [APP_CONFIG],
        },
        RunSweepsScheduler,
        RequestDailyPullRequestRefreshesHandler,
        {
          provide: DAILY_PULL_REQUEST_REFRESH_SETTINGS,
          useValue: {
            intervalMs: DAILY_REFRESH_INTERVAL_MS,
            ...options.pullRequestRefresh,
          } satisfies DailyPullRequestRefreshSettings,
        },
        DailyPullRequestRefreshScheduler,
      ],
    };
  }
}
