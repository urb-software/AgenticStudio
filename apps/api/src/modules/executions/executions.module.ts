import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { AuthModule } from '../../platform/auth/auth.module.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { RUN_LOG_REPOSITORY } from './domain/repositories/run-log-repository.js';
import { RUN_REPOSITORY } from './domain/repositories/run-repository.js';
import { AppendRunEventsEndpoint } from './features/append-run-events/endpoint.js';
import { AppendRunEventsHandler } from './features/append-run-events/handler.js';
import { ClaimRunEndpoint } from './features/claim-run/endpoint.js';
import { ClaimRunHandler } from './features/claim-run/handler.js';
import { GetRunEndpoint } from './features/get-run/endpoint.js';
import { GetRunHandler } from './features/get-run/handler.js';
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
import { RecordHeartbeatHandler } from './features/record-heartbeat/handler.js';
import { ReportRunStateEndpoint } from './features/report-run-state/endpoint.js';
import { ReportRunStateHandler } from './features/report-run-state/handler.js';
import { ReportRunStepEndpoint } from './features/report-run-step/endpoint.js';
import { ReportRunStepHandler } from './features/report-run-step/handler.js';
import { ReportWorkerStatusEndpoint } from './features/report-worker-status/endpoint.js';
import { ReportWorkerStatusHandler } from './features/report-worker-status/handler.js';
import { RetryDeliveryEndpoint } from './features/retry-delivery/endpoint.js';
import { RetryDeliveryHandler } from './features/retry-delivery/handler.js';
import { StartRunEndpoint } from './features/start-run/endpoint.js';
import { StartRunHandler } from './features/start-run/handler.js';
import { StreamRunEventsEndpoint } from './features/stream-run-events/endpoint.js';
import { StreamRunEventsHandler } from './features/stream-run-events/handler.js';
import { LogStreamSlots } from './features/stream-run-events/log-stream-slots.js';
import {
  LostWorkerSweepSchedule,
  SweepLostWorkersHandler,
} from './features/sweep-lost-workers/handler.js';
import { InProcessRunLogSignal } from './infrastructure/adapters/in-process-run-log-signal.js';
import { PlatformOperatorSessions } from './infrastructure/adapters/platform-operator-sessions.js';
import { PrismaRunLogRepository } from './infrastructure/repositories/prisma-run-log-repository.js';
import { InMemoryWorkerStatusStore } from './infrastructure/adapters/in-memory-worker-status-store.js';
import { PrismaRunRepository } from './infrastructure/repositories/prisma-run-repository.js';
import { CLOCK, type Clock } from './ports/clock.js';
import { OPERATOR_SESSIONS } from './ports/operator-sessions.js';
import { RUN_LOG_SETTINGS, type RunLogSettings } from './ports/run-log-settings.js';
import { RUN_LOG_SIGNAL } from './ports/run-log-signal.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from './ports/run-secret-values.js';
import { WORKER_LEASE, type WorkerLease } from './ports/worker-lease.js';
import { WORKER_STATUS_STORE } from './ports/worker-status-store.js';

/**
 * Test seams of the module: a controlled clock for the lease and the lost-worker sweep, a
 * shorter keep-alive interval of live log streams, and known secret values of Runs for log
 * redaction (until Environment files, #104, supply them). Production passes nothing.
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

/** No secret values are known to a Run until Environment files (#104) supply them. */
const NO_RUN_SECRET_VALUES: RunSecretValues = { forRun: () => Promise.resolve([]) };

/**
 * `executions` business module (Issues #96, #99): the operator starts and reads Runs; the agent
 * worker claims them and reports back over the worker routes (`/api/worker/`, worker token
 * only), including each Run's log, which the operator reads in pages or live. `projects` is
 * passed in by the composition root, which wires its public `RUN_START_POINTS` contract; this
 * module never imports it otherwise.
 */
@Module({})
export class ExecutionsModule {
  static register(projects: DynamicModule, options: ExecutionsModuleOptions = {}): DynamicModule {
    return {
      module: ExecutionsModule,
      // AuthModule: the live log stream re-checks its operator session (Issue #99 review).
      imports: [DatabaseModule, AuthModule, projects],
      controllers: [
        StartRunEndpoint,
        ListProjectRunsEndpoint,
        ListRunsEndpoint,
        GetRunEndpoint,
        RetryDeliveryEndpoint,
        ClaimRunEndpoint,
        ReportRunStateEndpoint,
        ReportRunStepEndpoint,
        RecordHeartbeatEndpoint,
        AppendRunEventsEndpoint,
        ListRunEventsEndpoint,
        StreamRunEventsEndpoint,
        ListRunStepsEndpoint,
        GetRunStatesEndpoint,
        ReportWorkerStatusEndpoint,
        ListProvidersEndpoint,
      ],
      providers: [
        { provide: RUN_REPOSITORY, useClass: PrismaRunRepository },
        { provide: RUN_LOG_REPOSITORY, useClass: PrismaRunLogRepository },
        { provide: RUN_LOG_SIGNAL, useClass: InProcessRunLogSignal },
        { provide: OPERATOR_SESSIONS, useClass: PlatformOperatorSessions },
        { provide: RUN_SECRET_VALUES, useValue: options.secretValues ?? NO_RUN_SECRET_VALUES },
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
        StartRunHandler,
        ListProjectRunsHandler,
        ListRunsHandler,
        GetRunHandler,
        RetryDeliveryHandler,
        ClaimRunHandler,
        ReportRunStateHandler,
        ReportRunStepHandler,
        RecordHeartbeatHandler,
        AppendRunEventsHandler,
        ListRunEventsHandler,
        StreamRunEventsHandler,
        LogStreamSlots,
        ListRunStepsHandler,
        GetRunStatesHandler,
        ReportWorkerStatusHandler,
        ListProvidersHandler,
        SweepLostWorkersHandler,
        LostWorkerSweepSchedule,
      ],
    };
  }
}
