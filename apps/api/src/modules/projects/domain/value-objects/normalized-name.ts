/**
 * A name in the form the Project name rules compare: NFC first (so NFC and NFD spellings are one
 * name), then trimmed, with whitespace runs collapsed to one space. Case is kept. Idempotent, so
 * it can run again after the HTTP edge. It has no length rule: the Project name adds those.
 */
export class NormalizedName {
  private constructor(readonly value: string) {}

  static of(raw: string): NormalizedName {
    return new NormalizedName(raw.normalize('NFC').trim().replace(/\s+/gu, ' '));
  }
}
