/** A text cut to at most a number of UTF-8 bytes, at a character boundary. */
export class CutText {
  private constructor(
    readonly text: string,
    readonly cut: boolean,
  ) {}

  /** It mirrors `cutToBytes` of the worker protocol: the domain may not import the contracts package. */
  static of(text: string, maxBytes: number): CutText {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes) return new CutText(text, false);
    let end = maxBytes;
    // Back off continuation bytes (10xxxxxx) so no character is split.
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return new CutText(bytes.subarray(0, end).toString('utf8'), true);
  }
}
