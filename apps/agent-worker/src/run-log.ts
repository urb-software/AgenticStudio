import {
  cutToBytes,
  jsonByteLength,
  RUN_EVENT_BATCH_MAX,
  RUN_EVENT_TEXT_MAX_BYTES,
  type RunEventInput,
  type RunEventKind,
} from '@agentic-studio/contracts';
import { isRunLost, type StudioApi } from './studio-api.js';

/** The notice sent once when the worker's buffer overflows. */
export const WORKER_BUFFER_NOTICE = 'log truncated (worker buffer)';

/** Batches are sent this often while events wait. */
const FLUSH_MS = 500;
/** Events the worker holds while Studio is unreachable; output beyond is dropped. */
const BUFFER_MAX = 10_000;
/** UTF-8 bytes of event text the worker holds at most (16 MiB); output beyond is dropped. */
const BUFFER_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Most bytes of events (as JSON) in one request, under the API's 100 KiB body limit with room
 * for the envelope. One event always fits alone: its text is at most 16 KiB of UTF-8, at most
 * 96 KiB as JSON even when every character is an escaped control character.
 */
const BATCH_BYTES = 64 * 1024;
const RETRY_MS = { first: 500, max: 10_000 } as const;
/** Default time {@link RunLog.close} keeps retrying before it gives up. */
const CLOSE_DEADLINE_MS = 30_000;

/** Markers bypass the overflow drop: they give the log its structure and are few. */
const MARKERS: readonly RunEventKind[] = ['step_started', 'step_finished'];

export interface RunLogOptions {
  api: Pick<StudioApi, 'appendEvents'>;
  runId: string;
  /** Where problems are written (the worker's logger); never event text. */
  logger: { error(message: string): void };
  /** Called once when Studio says this worker no longer holds the Run. */
  onLost: () => void;
  /** Buffer bound (tests make it small). */
  bufferMax?: number;
  /**
   * The seq of the first event (default 1): a resumed Run continues after the seqs Studio
   * stored, or Studio would drop its events as duplicates.
   */
  firstSeq?: number;
  /** Buffer bound in UTF-8 bytes of event text (tests make it small). */
  bufferMaxBytes?: number;
}

/**
 * Forwards one Run's events to Studio, numbered per Run (a resumed Run continues Studio's log), cut
 * to the per-event cap, buffered (10 000 events, 16 MiB; overflow is dropped with one
 * {@link WORKER_BUFFER_NOTICE}) and sent in order; a failed send is retried, never duplicated.
 */
export class RunLog {
  private seq = 0;
  private readonly buffer: RunEventInput[] = [];
  private readonly bufferMax: number;
  private readonly bufferMaxBytes: number;
  /** UTF-8 bytes of the texts in {@link buffer}. */
  private bufferBytes = 0;
  private overflowed = false;
  private lost = false;
  private pump: Promise<void> | undefined;
  private readonly stop = new AbortController();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: RunLogOptions) {
    this.seq = (options.firstSeq ?? 1) - 1;
    this.bufferMax = options.bufferMax ?? BUFFER_MAX;
    this.bufferMaxBytes = options.bufferMaxBytes ?? BUFFER_MAX_BYTES;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  /** Queues one event of Run step `stepIndex`. */
  push(stepIndex: number, kind: RunEventKind, text: string): void {
    if (this.lost) return;
    const event = cutToBytes(text, RUN_EVENT_TEXT_MAX_BYTES);
    if (!MARKERS.includes(kind)) {
      if (this.overflowed) return;
      const full =
        this.buffer.length >= this.bufferMax ||
        this.bufferBytes + utf8Length(event.text) > this.bufferMaxBytes;
      if (full) {
        this.overflowed = true;
        this.options.logger.error(`Run ${this.options.runId}: log buffer full; dropping output.`);
        this.enqueue(stepIndex, 'notice', { text: WORKER_BUFFER_NOTICE, cut: false });
        return;
      }
    }
    this.enqueue(stepIndex, kind, event);
    if (this.buffer.length >= RUN_EVENT_BATCH_MAX) this.flush();
  }

  /**
   * Sends what is buffered and stops; resolves once everything is delivered, the Run is lost,
   * or `deadlineMs` passed (the rest is then dropped, a send in flight abandoned).
   */
  async close(deadlineMs = CLOSE_DEADLINE_MS): Promise<void> {
    clearInterval(this.timer);
    // At the deadline a send in flight is abandoned too.
    const deadline = setTimeout(() => this.stop.abort(), deadlineMs);
    deadline.unref();
    this.flush();
    await this.pump;
    clearTimeout(deadline);
  }

  /** Drops everything at once (e.g. the worker stops); idempotent. */
  dispose(): void {
    clearInterval(this.timer);
    this.clear();
    this.stop.abort();
  }

  private enqueue(
    stepIndex: number,
    kind: RunEventKind,
    { text, cut }: { text: string; cut: boolean },
  ): void {
    this.seq += 1;
    this.buffer.push({
      seq: this.seq,
      at: new Date().toISOString(),
      stepIndex,
      kind,
      text,
      ...(cut ? { truncated: true } : {}),
    });
    this.bufferBytes += utf8Length(text);
  }

  private clear(): void {
    this.buffer.length = 0;
    this.bufferBytes = 0;
  }

  private flush(): void {
    if (this.pump || this.buffer.length === 0 || this.lost) return;
    this.pump = this.drain().finally(() => {
      this.pump = undefined;
    });
  }

  /** Sends batches until the buffer is empty; one pump at a time keeps the order. */
  private async drain(): Promise<void> {
    let wait: number = RETRY_MS.first;
    while (this.buffer.length > 0 && !this.lost && !this.stop.signal.aborted) {
      const batch = this.nextBatch();
      try {
        await this.options.api.appendEvents(this.options.runId, batch, this.stop.signal);
        for (const sent of this.buffer.splice(0, batch.length)) {
          this.bufferBytes -= utf8Length(sent.text);
        }
        wait = RETRY_MS.first;
      } catch (error) {
        if (isRunLost(error)) {
          this.lost = true;
          this.clear();
          this.options.onLost();
          return;
        }
        if (this.stop.signal.aborted) break;
        this.options.logger.error(
          `Run ${this.options.runId}: sending log events failed (${describe(error)}); retrying.`,
        );
        await sleep(wait, this.stop.signal);
        wait = Math.min(wait * 2, RETRY_MS.max);
      }
    }
    if (this.buffer.length > 0 && !this.lost) {
      this.options.logger.error(
        `Run ${this.options.runId}: dropping ${this.buffer.length} log events; Studio stayed unreachable.`,
      );
      this.clear();
    }
  }

  private nextBatch(): RunEventInput[] {
    const batch: RunEventInput[] = [];
    let bytes = 0;
    for (const event of this.buffer) {
      const size = jsonByteLength(event);
      if (
        batch.length === RUN_EVENT_BATCH_MAX ||
        (batch.length > 0 && bytes + size > BATCH_BYTES)
      ) {
        break;
      }
      batch.push(event);
      bytes += size;
    }
    return batch;
  }
}

/** Waits `ms`, or less when `signal` aborts (the loop then sees the abort). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const utf8Length = (text: string) => Buffer.byteLength(text, 'utf8');

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
