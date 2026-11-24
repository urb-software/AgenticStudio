export class InvalidPreviewCommitError extends Error {
  constructor() {
    super('The commit is a full 40-character Git commit id.');
    this.name = 'InvalidPreviewCommitError';
  }
}

/** The commit a Preview is built from. */
export class PreviewCommit {
  private constructor(readonly value: string) {}

  /** Throws {@link InvalidPreviewCommitError}. */
  static of(commit: string): PreviewCommit {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new InvalidPreviewCommitError();
    return new PreviewCommit(commit);
  }
}
