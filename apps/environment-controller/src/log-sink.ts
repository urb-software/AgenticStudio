import {
  type AppendOperationLogResponse,
  type OperationLogLine,
  PREVIEW_LOG_BATCH_MAX_BYTES,
  PREVIEW_LOG_BATCH_MAX_LINES,
  PREVIEW_LOG_LINE_MAX_BYTES,
  type PreviewLogStream,
} from '@agentic-studio/contracts';

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function cutUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) to the start of the last whole character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

export interface LogSinkOptions {
  send: (lines: OperationLogLine[]) => Promise<AppendOperationLogResponse>;
  now?: () => Date;
  /** Longest wait before a line is sent (default 1 s). */
  flushMs?: number;
  /** A send failed; the lines of that batch are not sent again. */
  onError?: (error: unknown) => void;
}

/**
 * Collects an operation's log lines and sends them to the API in batches: 100 lines, 64 KiB of
 * text or one second, whichever comes first. A line is cut at 2048 bytes. Once the API says its
 * cap is reached the sink drops what follows. Only one batch is in flight at a time.
 */
export class LogSink {
  private batch: OperationLogLine[] = [];
  private batchBytes = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private capReached = false;
  private failure: { error: unknown } | undefined;

  constructor(private readonly options: LogSinkOptions) {}

  /** Whether the API stopped storing lines. */
  get truncated(): boolean {
    return this.capReached;
  }

  write(stream: PreviewLogStream, text: string): void {
    if (this.capReached) return;
    const { text: line, cut } = cutUtf8(text.replace(/\r/g, ''), PREVIEW_LOG_LINE_MAX_BYTES);
    const size = Buffer.byteLength(line);
    if (this.batch.length > 0 && this.batchBytes + size > PREVIEW_LOG_BATCH_MAX_BYTES) {
      this.queueSend();
    }
    this.seq += 1;
    this.batch.push({
      seq: this.seq,
      at: (this.options.now?.() ?? new Date()).toISOString(),
      stream,
      text: line,
      ...(cut ? { truncated: true } : {}),
    });
    this.batchBytes += size;
    if (this.batch.length >= PREVIEW_LOG_BATCH_MAX_LINES) this.queueSend();
    else this.timer ??= setTimeout(() => this.queueSend(), this.options.flushMs ?? 1000);
  }

  /** Sends what is collected and waits for every batch in flight; rejects if a send failed. */
  async flush(): Promise<void> {
    this.queueSend();
    await this.chain;
    const failed = this.failure;
    this.failure = undefined;
    if (failed) throw failed.error;
  }

  private queueSend(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.batch.length === 0) return;
    const lines = this.batch;
    this.batch = [];
    this.batchBytes = 0;
    this.chain = this.chain.then(async () => {
      if (this.capReached) return;
      try {
        const answer = await this.options.send(lines);
        if (answer.truncated) this.capReached = true;
      } catch (error) {
        this.failure ??= { error };
        this.options.onError?.(error);
      }
    });
  }
}
