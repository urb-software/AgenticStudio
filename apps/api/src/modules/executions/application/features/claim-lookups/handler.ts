import { Inject, Injectable } from '@nestjs/common';
import { LookupHandOutRule } from '../../../domain/value-objects/lookup-hand-out-rule.js';
import type { ClaimedLookup } from '../../../domain/entities/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface ClaimLookupsInput {
  workerId: string;
}

export interface ClaimLookupsResult {
  /** What the worker needs to answer each claimed lookup, nothing more. */
  lookups: ClaimedLookup[];
}

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

  async execute(input: ClaimLookupsInput): Promise<ClaimLookupsResult> {
    // The hand-out is the store's one atomic step; the rule supplies its lease and limit.
    return {
      lookups: await this.lookups.claim(input.workerId, LookupHandOutRule.at(this.clock.now())),
    };
  }
}
