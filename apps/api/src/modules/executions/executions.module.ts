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
import { AnswerRunEndpoint } from './entry-points/http/operator/answer-run/endpoint.js';
import { AnswerRunHandler } from './application/features/answer-run/handler.js';
import { CancelLongWaitingRunsHandler } from './application/features/cancel-long-waiting-runs/handler.js';
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
import { OPERATOR_SESSIONS } from './application/ports/operator-sessions.js';
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

/**
 * Test seams of the module: a controlled clock for the lease and the lost-worker sweep, a
 * shorter keep-alive interval of live log streams, and known secret values of Runs for log
 * redaction in place of the Runs' Environment file snapshots (#104). Production passes nothing.
 */
export interface ExecutionsModuleOptions {
  clock?: Clock;
  logKeepAliveMs?: number;
  /** Lower stream limits for tests (defaults: 5 per session, 50 in total). */
  logStreamLimits?: { perSession: number; total: number };
  secretValues?: RunSecretValues;
  /** The daily pull request refresh (Issue #142): a test runs its passes by hand. */
  pullRequestRefresh?: Pick<DailyPullRequestRefreshSettings, 'manual'>;
}

const SYSTEM_CLOCK: Clock = { now: () => new Date() };

/** An idle live log stream sends a keep-alive comment this often (Issue #99). */
const LOG_KEEP_ALIVE_MS = 15_000;

/** Most open live log streams per operator session, and in total (Issue #99 review). */
const LOG_STREAMS_PER_SESSION = 5;
const LOG_STREAMS_TOTAL = 50;

/**
 * `executions` business module (Issues #96, #99, #100, #103, #142, #144): the operator starts, reads,
 * cancels and answers Runs; the agent
 * worker claims them and reports back over the worker routes (`/api/worker/`, worker token
 * only), including each Run's log, which the operator reads in pages or live. A claimed Run gets
 * a snapshot of its Project's Environment file (Issue #104, `projects`' public
 * `RUN_ENVIRONMENT_FILES` contract), kept in the secret store for its log redaction until it is
 * final. `projects` is passed in by the composition root, which wires its public contracts;
 * this module never imports it otherwise.
 */
@Module({})
export class ExecutionsModule {
  static register(projects: DynamicModule, options: ExecutionsModuleOptions = {}): DynamicModule {
    return {
      module: ExecutionsModule,
      // AuthModule: the live log stream re-checks its operator session (Issue #99 review).
      imports: [DatabaseModule, AuthModule, SecretsModule, projects],
      controllers: [
        StartRunEndpoint,
        ListProjectRunsEndpoint,
        ListRunsEndpoint,
        // Before GetRunEndpoint: `runs/:runId` would take `runs/summary` (Issue #115).
        GetRunsSummaryEndpoint,
        GetRunEndpoint,
        CancelRunEndpoint,
        RetryDeliveryEndpoint,
        AnswerRunEndpoint,
        ResumeRunEndpoint,
        FollowUpRunEndpoint,
        BringUpToDateEndpoint,
        RefreshPullRequestEndpoint,
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
          provide: RUN_LIMITS,
          useFactory: (config: AppConfig): RunLimitsSetting => ({ ...config.runLimits }),
          inject: [APP_CONFIG],
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
          // Half the lease, and at most every 30 s.
          useFactory: (config: AppConfig): RunSweepsSettings => ({
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
