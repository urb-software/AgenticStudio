import { Inject, Injectable } from '@nestjs/common';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { LeaseRenewalRule } from '../../../domain/value-objects/run-sweep-rules.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';

export interface RenewHeldRunLeasesResult {
  /** How many leases were renewed, or `null` when they were renewed less than a lease ago. */
  renewed: number | null;
}

/**
 * At most once per lease period, so an API that keeps crashing cannot keep a dead worker's Run
 * alive.
 */
@Injectable()
export class RenewHeldRunLeasesHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(): Promise<RenewHeldRunLeasesResult> {
    const rule = LeaseRenewalRule.at(this.clock.now(), this.lease.seconds);
    return { renewed: await this.runs.renewClaimsOncePerLease(rule.now, rule.leaseSeconds) };
  }
}
