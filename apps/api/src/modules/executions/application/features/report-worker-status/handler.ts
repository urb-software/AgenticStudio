import { Inject, Injectable } from '@nestjs/common';
import type { RecordedWorkerStatus } from '../../../domain/value-objects/worker-status.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

export type ReportWorkerStatusInput = Omit<RecordedWorkerStatus, 'reportedAt'>;

export type ReportWorkerStatusResult = void;

/**
 * Command (Issue #101): an agent worker reports its runner mode and which providers its own
 * configuration enables. Studio keeps the latest report, for display and to refuse starting a
 * Run it knows cannot run. Issue #143: the report also carries the disk figures of the agent side.
 */
@Injectable()
export class ReportWorkerStatusHandler {
  constructor(
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(report: ReportWorkerStatusInput): Promise<ReportWorkerStatusResult> {
    this.statuses.record({
      workerId: report.workerId,
      runner: report.runner,
      providers: { ...report.providers },
      ...(report.providerReasons ? { providerReasons: { ...report.providerReasons } } : {}),
      ...(report.disk ? { disk: { ...report.disk } } : {}),
      reportedAt: this.clock.now(),
    });
  }
}
