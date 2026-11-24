import { PreviewLogLine } from './preview-log-line.js';

export const PREVIEW_LOG_TRUNCATED_NOTICE =
  "log truncated: the operation's log reached its size limit; later output is not stored";

export interface PreviewLogCapState {
  bytes: number;
  truncated: boolean;
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** How much of an operation's log is stored: the first lines up to a byte limit, then one notice. */
export class PreviewLogCap {
  private constructor(readonly state: PreviewLogCapState) {}

  static of(state: PreviewLogCapState): PreviewLogCap {
    return new PreviewLogCap({ ...state });
  }

  /**
   * The first line that does not fit becomes one {@link PREVIEW_LOG_TRUNCATED_NOTICE}; it and
   * every later line are dropped.
   */
  plan(
    lines: readonly PreviewLogLine[],
    maxBytes: number,
  ): { store: PreviewLogLine[]; state: PreviewLogCapState } {
    const { state } = this;
    if (state.truncated) return { store: [], state };
    const store: PreviewLogLine[] = [];
    let bytes = state.bytes;
    for (const line of lines) {
      const size = utf8Length(line.text);
      if (bytes + size > maxBytes) {
        store.push(
          PreviewLogLine.restore({
            seq: line.seq,
            at: line.at,
            stream: 'controller',
            text: PREVIEW_LOG_TRUNCATED_NOTICE,
            truncated: false,
          }),
        );
        return { store, state: { bytes, truncated: true } };
      }
      bytes += size;
      store.push(line);
    }
    return { store, state: { bytes, truncated: false } };
  }
}
