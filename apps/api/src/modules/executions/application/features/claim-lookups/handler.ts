import { Inject, Injectable } from '@nestjs/common';
import { LookupHandOutRule } from '../../../domain/value-objects/lookup-hand-out-rule.js';
import type { ClaimedLookup } from '../../../domain/repositories/run-lookup-repository.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface ClaimLookupsInput {
  workerId: string;
}

export interface ClaimLookupsResult {
  lookups: ClaimedLookup[];
}

/** A claim the worker never answered goes back to the queue after the lease. */
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
