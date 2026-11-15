import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { RUN_REPOSITORY } from './domain/repositories/run-repository.js';
import { ClaimRunEndpoint } from './features/claim-run/endpoint.js';
import { ClaimRunHandler } from './features/claim-run/handler.js';
import { GetRunEndpoint } from './features/get-run/endpoint.js';
import { GetRunHandler } from './features/get-run/handler.js';
import { GetRunStatesEndpoint } from './features/get-run-states/endpoint.js';
import { GetRunStatesHandler } from './features/get-run-states/handler.js';
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
import { StartRunEndpoint } from './features/start-run/endpoint.js';
import { StartRunHandler } from './features/start-run/handler.js';
import {
  LostWorkerSweepSchedule,
  SweepLostWorkersHandler,
} from './features/sweep-lost-workers/handler.js';
import { PrismaRunRepository } from './infrastructure/repositories/prisma-run-repository.js';
import { CLOCK, type Clock } from './ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from './ports/worker-lease.js';

/**
 * Test seam of the module: a controlled clock for the lease and the lost-worker sweep.
 * Production passes nothing and gets the system clock.
 */
export interface ExecutionsModuleOptions {
  clock?: Clock;
}

const SYSTEM_CLOCK: Clock = { now: () => new Date() };

/**
 * `executions` business module (Issue #96): the operator starts and reads Runs; the agent
 * worker claims them and reports back over the worker routes (`/api/worker/`, worker token
 * only). `projects` is passed in by the composition root, which wires its public
 * `RUN_START_POINTS` contract; this module never imports it otherwise.
 */
@Module({})
export class ExecutionsModule {
  static register(projects: DynamicModule, options: ExecutionsModuleOptions = {}): DynamicModule {
    return {
      module: ExecutionsModule,
      imports: [DatabaseModule, projects],
      controllers: [
        StartRunEndpoint,
        ListProjectRunsEndpoint,
        ListRunsEndpoint,
        GetRunEndpoint,
        ClaimRunEndpoint,
        ReportRunStateEndpoint,
        ReportRunStepEndpoint,
        RecordHeartbeatEndpoint,
        GetRunStatesEndpoint,
      ],
      providers: [
        { provide: RUN_REPOSITORY, useClass: PrismaRunRepository },
        { provide: CLOCK, useValue: options.clock ?? SYSTEM_CLOCK },
        {
          provide: WORKER_LEASE,
          useFactory: (config: AppConfig): WorkerLease => ({ seconds: config.workerLeaseSeconds }),
          inject: [APP_CONFIG],
        },
        StartRunHandler,
        ListProjectRunsHandler,
        ListRunsHandler,
        GetRunHandler,
        ClaimRunHandler,
        ReportRunStateHandler,
        ReportRunStepHandler,
        RecordHeartbeatHandler,
        GetRunStatesHandler,
        SweepLostWorkersHandler,
        LostWorkerSweepSchedule,
      ],
    };
  }
}
