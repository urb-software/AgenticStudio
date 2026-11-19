import { CutText } from './cut-text.js';
import type { LogRedaction } from './log-redaction.js';
import type { RunEventKind } from './run-event-kind.js';

export interface RunEventData {
  seq: number;
  at: Date;
  stepIndex: number;
  kind: RunEventKind;
  text: string;
  truncated: boolean;
}

/** One line of a Run's log, as stored: its text redacted and cut to its byte size. */
export class RunEvent {
  /** The worker protocol's limit is pinned to this one by a test. */
  static readonly TEXT_MAX_BYTES = 16 * 1024;

  private constructor(
    readonly seq: number,
    readonly at: Date,
    readonly stepIndex: number,
    readonly kind: RunEventKind,
    readonly text: string,
    readonly truncated: boolean,
  ) {}

  /**
   * An event as a worker reported it. The text is redacted first, because redaction can lengthen
   * it and the cut must not split a secret open; `truncated` is set when the worker or the cut
   * removed something.
   */
  static load(
    reported: Omit<RunEventData, 'truncated'> & { truncated?: boolean },
    redaction: LogRedaction,
  ): RunEvent {
    const cut = CutText.likeWorkerProtocol(redaction.text(reported.text), RunEvent.TEXT_MAX_BYTES);
    return new RunEvent(
      reported.seq,
      reported.at,
      reported.stepIndex,
      reported.kind,
      cut.text,
      reported.truncated === true || cut.cut,
    );
  }

  /** An event as storage holds it: the text is kept as it is. */
  static restore(stored: RunEventData): RunEvent {
    return new RunEvent(
      stored.seq,
      stored.at,
      stored.stepIndex,
      stored.kind,
      stored.text,
      stored.truncated,
    );
  }
}
