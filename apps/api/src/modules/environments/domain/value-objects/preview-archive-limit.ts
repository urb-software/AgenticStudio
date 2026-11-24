/** The most a source archive of a build may hold; the controller protocol's limit is pinned to this one by a test. */
export class PreviewArchiveLimit {
  static readonly MAX_BYTES = 256 * 1024 * 1024;

  private constructor(readonly maxBytes: number) {}

  static standard(): PreviewArchiveLimit {
    return new PreviewArchiveLimit(PreviewArchiveLimit.MAX_BYTES);
  }
}
