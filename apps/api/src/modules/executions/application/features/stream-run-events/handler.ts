import { Inject, Injectable } from '@nestjs/common';
import { isFinalRunState } from '../../../domain/value-objects/run-state.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import type { RunEvent } from '../../../domain/value-objects/run-event.js';
import { RUN_LOG, type RunLog } from '../../ports/run-log.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { RUN_LOG_SETTINGS, type RunLogSettings } from '../../ports/run-log-settings.js';
import { RUN_LOG_SIGNAL, type RunLogSignal } from '../../ports/run-log-signal.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

/** Yielded when the stream was idle for the keep-alive interval. */
export const KEEP_ALIVE = 'keep-alive';

/** What a live stream yields: stored events in seq order, or a keep-alive tick. */
export type RunLogStreamItem = RunEvent[] | typeof KEEP_ALIVE;

/** Events read from the store at a time. */
const READ_PAGE = 500;

export interface StreamRunEventsInput {
  runId: string;
  /** The last seq the client saw; the stream starts after it. */
  after: number;
  abort: AbortSignal;
}

export interface StreamRunEventsResult {
  stream: AsyncGenerator<RunLogStreamItem>;
}

/**
 * Query (Issue #99): a Run's log as a live stream, built on the stored log. It catches up from
 * the store after `after`, then waits for the in-process signal (or the keep-alive interval)
 * and reads again. It ends once the Run is final and every event is sent, or when `abort`
 * fires. A reconnecting client passes the last seq it saw, so nothing is lost or repeated.
 */
@Injectable()
export class StreamRunEventsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOG) private readonly log: RunLog,
    @Inject(RUN_LOG_SIGNAL) private readonly signal: RunLogSignal,
    @Inject(RUN_LOG_SETTINGS) private readonly settings: RunLogSettings,
  ) {}

  /** Throws {@link RunNotFoundError} before anything is streamed. */
  async execute(input: StreamRunEventsInput): Promise<StreamRunEventsResult> {
    const { runId, after, abort } = input;
    if (!isRunId(runId) || !(await this.runs.exists(runId))) throw new RunNotFoundError();
    return { stream: this.stream(runId, after, abort) };
  }

  private async *stream(
    runId: string,
    after: number,
    abort: AbortSignal,
  ): AsyncGenerator<RunLogStreamItem> {
    let cursor = after;
    let woken = false;
    let wake: (() => void) | undefined;
    const unsubscribe = this.signal.subscribe(runId, () => {
      woken = true;
      wake?.();
    });
    try {
      while (!abort.aborted) {
        woken = false;
        // The state is read before the log: a worker appends only while it holds the Run, so
        // once it is final, the read below sees every event there will ever be.
        const [run] = await this.runs.findStates([runId]);
        for (;;) {
          const page = await this.log.listAfter(runId, cursor, READ_PAGE);
          if (page.length === 0) break;
          cursor = page.at(-1)!.seq;
          yield page;
          if (page.length < READ_PAGE) break;
        }
        if (!run || isFinalRunState(run.state) || abort.aborted) return;
        if (!woken) {
          const timedOut = await new Promise<boolean>((resolve) => {
            const done = (value: boolean) => {
              clearTimeout(timer);
              abort.removeEventListener('abort', onAbort);
              wake = undefined;
              resolve(value);
            };
            const onAbort = () => done(false);
            const timer = setTimeout(() => done(true), this.settings.keepAliveMs);
            wake = () => done(false);
            abort.addEventListener('abort', onAbort, { once: true });
          });
          if (timedOut) yield KEEP_ALIVE;
        }
      }
    } finally {
      unsubscribe();
    }
  }
}
