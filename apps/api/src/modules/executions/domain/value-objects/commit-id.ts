/** A commit id compared without regard to letter case. */
export class CommitId {
  private constructor(private readonly value: string) {}

  static of(value: string): CommitId {
    return new CommitId(value.toLowerCase());
  }

  /** `null` (no commit known) is never equal. */
  equals(other: string | null): boolean {
    return other !== null && this.value === other.toLowerCase();
  }
}
