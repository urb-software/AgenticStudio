export const RESUME_REASONS = ['answer', 'usage_limit', 'follow_up', 'bring_up_to_date'] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

export class RunResume {
  private constructor(
    readonly text: string,
    readonly reason: ResumeReason,
  ) {}

  static of(text: string, reason: ResumeReason): RunResume {
    return new RunResume(text, reason);
  }

  /**
   * A Follow-up, and a usage-limit resume inside one (`followUpCount` above zero), work with the Project's current
   * file (or none), snapshotted at the claim as at a Run's start.
   */
  takesNewEnvironmentFile(followUpCount: number): boolean {
    return (
      this.reason === 'follow_up' ||
      this.reason === 'bring_up_to_date' ||
      (this.reason === 'usage_limit' && followUpCount > 0)
    );
  }
}
