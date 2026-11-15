import { Inject, Injectable } from '@nestjs/common';
import type { WorkerStatus } from '../../domain/services/provider-availability.js';
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

  execute(report: Omit<WorkerStatus, 'reportedAt'>): void {
    this.statuses.record({
      workerId: report.workerId,
      runner: report.runner,
      providers: { claude_code: report.providers.claude_code, codex: report.providers.codex },
      reportedAt: this.clock.now(),
    });
  }
}
