import { REDACTED } from '@agentic-studio/log-redaction';
import type { PreviewLogRedaction } from './preview-log-redaction.js';

export const PREVIEW_LOG_STREAMS = ['build', 'start', 'controller'] as const;
export type PreviewLogStream = (typeof PREVIEW_LOG_STREAMS)[number];

export interface PreviewLogLineData {
  seq: number;
  at: Date;
  stream: PreviewLogStream;
  text: string;
  truncated: boolean;
}

/** One line of a Preview operation's log, as stored: redacted and cut to its byte size. */
export class PreviewLogLine {
  /** The controller protocol's limit is pinned to this one by a test. */
  static readonly TEXT_MAX_BYTES = 2048;

  private constructor(
    readonly seq: number,
    readonly at: Date,
    readonly stream: PreviewLogStream,
    readonly text: string,
    readonly truncated: boolean,
  ) {}

  /**
   * A line as the controller reported it. The text is redacted first, because redaction can
   * lengthen it and the cut must not split a secret open; `truncated` is set when the controller
   * or the cut removed something.
   */
  static load(
    reported: Omit<PreviewLogLineData, 'truncated'> & { truncated?: boolean },
    redaction: PreviewLogRedaction,
  ): PreviewLogLine {
    const bytes = new TextEncoder().encode(redaction.text(reported.text));
    let end = Math.min(bytes.length, PreviewLogLine.TEXT_MAX_BYTES);
    // Back off continuation bytes (10xxxxxx) so no character is split.
    while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    const cut = end < bytes.length;
    return new PreviewLogLine(
      reported.seq,
      reported.at,
      reported.stream,
      new TextDecoder().decode(bytes.subarray(0, end)),
      reported.truncated === true || cut,
    );
  }

  /** Whether the text holds the marker that stands for a removed secret. */
  get redacted(): boolean {
    return this.text.includes(REDACTED);
  }

  static restore(data: PreviewLogLineData): PreviewLogLine {
    return new PreviewLogLine(data.seq, data.at, data.stream, data.text, data.truncated);
  }
}
