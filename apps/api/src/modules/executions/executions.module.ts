import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { AuthModule } from '../../platform/auth/auth.module.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { SecretsModule } from '../../platform/secrets/secrets.module.js';
import { RUN_DIFF_REPOSITORY } from './domain/repositories/run-diff-repository.js';
import { RUN_LOG_REPOSITORY } from './domain/repositories/run-log-repository.js';
import { RUN_LOOKUP_REPOSITORY } from './domain/repositories/run-lookup-repository.js';
import { RUN_REPOSITORY } from './domain/repositories/run-repository.js';
import { AnswerRunEndpoint } from './features/answer-run/endpoint.js';
import { AnswerRunHandler } from './features/answer-run/handler.js';
import { CancelLongWaitingRunsHandler } from './features/cancel-long-waiting-runs/handler.js';
import { CancelRunEndpoint } from './features/cancel-run/endpoint.js';
import { CancelRunHandler } from './features/cancel-run/handler.js';
import { AppendRunEventsEndpoint } from './features/append-run-events/endpoint.js';
import { AppendRunEventsHandler } from './features/append-run-events/handler.js';
import { ClaimLookupsEndpoint } from './features/claim-lookups/endpoint.js';
import { ClaimLookupsHandler } from './features/claim-lookups/handler.js';
import { ClaimRunEndpoint } from './features/claim-run/endpoint.js';
import { ClaimRunHandler } from './features/claim-run/handler.js';
import { GetRunEndpoint } from './features/get-run/endpoint.js';
import { GetRunsSummaryEndpoint } from './features/get-runs-summary/endpoint.js';
import { GetRunsSummaryHandler } from './features/get-runs-summary/handler.js';
import { GetRunHandler } from './features/get-run/handler.js';
import { GetRunDiffEndpoint } from './features/get-run-diff/endpoint.js';
import { GetRunDiffHandler } from './features/get-run-diff/handler.js';
import { ListRunEventsEndpoint } from './features/list-run-events/endpoint.js';
import { ListRunEventsHandler } from './features/list-run-events/handler.js';
import { ListRunStepsEndpoint } from './features/list-run-steps/endpoint.js';
import { ListRunStepsHandler } from './features/list-run-steps/handler.js';
import { GetRunStatesEndpoint } from './features/get-run-states/endpoint.js';
import { GetRunStatesHandler } from './features/get-run-states/handler.js';
import { ListProvidersEndpoint } from './features/list-providers/endpoint.js';
import { ListProvidersHandler } from './features/list-providers/handler.js';
import { ListProjectRunsEndpoint } from './features/list-project-runs/endpoint.js';
import { ListProjectRunsHandler } from './features/list-project-runs/handler.js';
import { ListRunsEndpoint } from './features/list-runs/endpoint.js';
import { ListRunsHandler } from './features/list-runs/handler.js';
import { RecordHeartbeatEndpoint } from './features/record-heartbeat/endpoint.js';
import { RefreshPullRequestEndpoint } from './features/refresh-pull-request/endpoint.js';
import { RefreshPullRequestHandler } from './features/refresh-pull-request/handler.js';
import { ReportLookupResultEndpoint } from './features/report-lookup-result/endpoint.js';
import { ReportLookupResultHandler } from './features/report-lookup-result/handler.js';
import { RecordHeartbeatHandler } from './features/record-heartbeat/handler.js';
import { ReportRunDiffEndpoint } from './features/report-run-diff/endpoint.js';
import { ReportRunDiffHandler } from './features/report-run-diff/handler.js';
import { ReportRunStateEndpoint } from './features/report-run-state/endpoint.js';
import { ReportRunStateHandler } from './features/report-run-state/handler.js';
import { ReportRunStepEndpoint } from './features/report-run-step/endpoint.js';
import { ReportRunStepHandler } from './features/report-run-step/handler.js';
import { ReportWorkerStatusEndpoint } from './features/report-worker-status/endpoint.js';
import { ReportWorkerStatusHandler } from './features/report-worker-status/handler.js';
import { RetryDeliveryEndpoint } from './features/retry-delivery/endpoint.js';
import { RetryDeliveryHandler } from './features/retry-delivery/handler.js';
import { FollowUpRunEndpoint } from './features/follow-up-run/endpoint.js';
import { FollowUpRunHandler } from './features/follow-up-run/handler.js';
import { ResumeRunEndpoint } from './features/resume-run/endpoint.js';
import { ResumeRunHandler } from './features/resume-run/handler.js';
import { StartRunEndpoint } from './features/start-run/endpoint.js';
import { StartRunHandler } from './features/start-run/handler.js';
import { StreamRunEventsEndpoint } from './features/stream-run-events/endpoint.js';
import { StreamRunEventsHandler } from './features/stream-run-events/handler.js';
import { LogStreamSlots } from './features/stream-run-events/log-stream-slots.js';
import {
  LostWorkerSweepSchedule,
  SweepLostWorkersHandler,
} from './features/sweep-lost-workers/handler.js';
import { EnvironmentFileSecretValues } from './infrastructure/adapters/environment-file-secret-values.js';
import { SecretStoreEnvironmentFileSnapshots } from './infrastructure/adapters/environment-file-snapshots.js';
import {
  ENVIRONMENT_FILE_SNAPSHOTS,
  RUN_SNAPSHOT_SETTINGS,
  type RunSnapshotSettings,
} from './ports/environment-file-snapshots.js';
import { InProcessRunLogSignal } from './infrastructure/adapters/in-process-run-log-signal.js';
import { PlatformOperatorSessions } from './infrastructure/adapters/platform-operator-sessions.js';
import { PrismaRunDiffRepository } from './infrastructure/repositories/prisma-run-diff-repository.js';
import { PrismaRunLogRepository } from './infrastructure/repositories/prisma-run-log-repository.js';
import { PrismaRunLookupRepository } from './infrastructure/repositories/prisma-run-lookup-repository.js';
import { InMemoryWorkerStatusStore } from './infrastructure/adapters/in-memory-worker-status-store.js';
import { PrismaRunRepository } from './infrastructure/repositories/prisma-run-repository.js';
import { CLOCK, type Clock } from './ports/clock.js';
import { RUN_LIMITS, type RunLimitsSetting } from './ports/run-limits.js';
import { OPERATOR_SESSIONS } from './ports/operator-sessions.js';
import { RUN_LOG_SETTINGS, type RunLogSettings } from './ports/run-log-settings.js';
import { RUN_LOG_SIGNAL } from './ports/run-log-signal.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from './ports/run-secret-values.js';
import { WORKER_LEASE, type WorkerLease } from './ports/worker-lease.js';
import { WORKER_STATUS_STORE } from './ports/worker-status-store.js';

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
        RefreshPullRequestEndpoint,
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
      ],
      providers: [
        { provide: RUN_REPOSITORY, useClass: PrismaRunRepository },
        { provide: RUN_LOG_REPOSITORY, useClass: PrismaRunLogRepository },
        { provide: RUN_DIFF_REPOSITORY, useClass: PrismaRunDiffRepository },
        { provide: RUN_LOOKUP_REPOSITORY, useClass: PrismaRunLookupRepository },
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
        ListRunStepsHandler,
        GetRunDiffHandler,
        ReportRunDiffHandler,
        GetRunStatesHandler,
        ReportWorkerStatusHandler,
        ListProvidersHandler,
        SweepLostWorkersHandler,
        { provide: ENVIRONMENT_FILE_SNAPSHOTS, useClass: SecretStoreEnvironmentFileSnapshots },
        {
          provide: RUN_SNAPSHOT_SETTINGS,
          useFactory: (config: AppConfig): RunSnapshotSettings => ({
            retentionDays: config.runSnapshotRetentionDays,
          }),
          inject: [APP_CONFIG],
        },
        LostWorkerSweepSchedule,
      ],
    };
  }
}
