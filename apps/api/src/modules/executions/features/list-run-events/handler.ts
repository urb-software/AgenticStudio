import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../domain/entities/run.js';
import type { RunEvent } from '../../domain/entities/run-event.js';
import {
  RUN_LOG_REPOSITORY,
  type RunLogRepository,
} from '../../domain/repositories/run-log-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';

/** Events per page when the caller names no limit, and the most it may ask for. */
export const RUN_EVENTS_PAGE = { default: 500, max: 1000 } as const;

export interface RunEventPage {
  events: RunEvent[];
  /** The seq to pass as `after` for the next page; absent on the last page. */
  next?: number;
}

/**
 * Query (Issue #99): one page of a Run's stored log, the events after `after` in seq order.
 * Throws {@link RunNotFoundError}, also for an id that is not a UUID.
 */
@Injectable()
export class ListRunEventsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOG_REPOSITORY) private readonly log: RunLogRepository,
  ) {}

  async execute(runId: string, after: number, limit: number): Promise<RunEventPage> {
    if (!isRunId(runId) || !(await this.runs.findById(runId))) throw new RunNotFoundError();
    // One more than asked tells whether another page follows.
    const events = await this.log.listAfter(runId, after, limit + 1);
    if (events.length <= limit) return { events };
    const page = events.slice(0, limit);
    return { events: page, next: page.at(-1)!.seq };
  }
}
