import { Inject, Injectable } from '@nestjs/common';
import type { RecordedWorkerStatus } from '../../domain/services/provider-availability.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/**
 * Command (Issue #101): an agent worker reports its runner mode and which providers its own
 * configuration enables. Studio keeps the latest report, for display and to refuse starting a
 * Run it knows cannot run.
 */
@Injectable()
export class ReportWorkerStatusHandler {
  constructor(
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(report: Omit<RecordedWorkerStatus, 'reportedAt'>): void {
    this.statuses.record({
      workerId: report.workerId,
      runner: report.runner,
      providers: { ...report.providers },
      ...(report.providerReasons ? { providerReasons: { ...report.providerReasons } } : {}),
      reportedAt: this.clock.now(),
    });
  }
}
