/** A text cut to at most a number of UTF-8 bytes, at a character boundary. */
export class CutText {
  private constructor(
    readonly text: string,
    readonly cut: boolean,
  ) {}

  /** Decodes the kept bytes with `Buffer`, which keeps a leading U+FEFF. Used for Review comments. */
  static of(text: string, maxBytes: number): CutText {
    return CutText.cutWith(text, maxBytes, (bytes) => Buffer.from(bytes).toString('utf8'));
  }

  /**
   * Mirrors `cutToBytes` of the worker protocol (the domain may not import the contracts package),
   * which decodes with a default `TextDecoder` and so drops a leading U+FEFF of a text it cuts.
   * Used for Run events.
   */
  static likeWorkerProtocol(text: string, maxBytes: number): CutText {
    return CutText.cutWith(text, maxBytes, (bytes) => new TextDecoder().decode(bytes));
  }

  private static cutWith(
    text: string,
    maxBytes: number,
    decode: (bytes: Uint8Array) => string,
  ): CutText {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= maxBytes) return new CutText(text, false);
    let end = maxBytes;
    // Back off continuation bytes (10xxxxxx) so no character is split.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    return new CutText(decode(bytes.subarray(0, end)), true);
  }
}
