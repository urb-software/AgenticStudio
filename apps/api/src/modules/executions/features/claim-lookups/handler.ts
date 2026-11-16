import { Inject, Injectable } from '@nestjs/common';
import {
  type ClaimedLookup,
  LOOKUP_CLAIM_MAX,
  LOOKUP_LEASE_SECONDS,
} from '../../domain/entities/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

/**
 * Command (Issue #142): an agent worker asks for the lookups waiting for it. Any connected
 * worker may claim them (a lookup needs no Working copy); a claim the worker never answered
 * goes back to the queue after the lease.
 */
@Injectable()
export class ClaimLookupsHandler {
  constructor(
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(workerId: string): Promise<ClaimedLookup[]> {
    return this.lookups.claim(workerId, this.clock.now(), LOOKUP_CLAIM_MAX, LOOKUP_LEASE_SECONDS);
  }
}
