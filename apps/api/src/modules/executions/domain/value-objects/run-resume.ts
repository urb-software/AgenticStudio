/** Why a resumed Run step continues the agent session (Issue #141; the worker protocol's list). */
export const RESUME_REASONS = ['answer', 'usage_limit', 'follow_up', 'bring_up_to_date'] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

/**
 * The message that resumes a Run's agent session, and why (Issue #103, #105, #141): what the
 * claim hands the worker of a Run that waits in the queue to be resumed.
 */
export class RunResume {
  private constructor(
    readonly text: string,
    readonly reason: ResumeReason,
  ) {}

  static of(text: string, reason: ResumeReason): RunResume {
    return new RunResume(text, reason);
  }

  /**
   * Whether the resume claim takes a new snapshot of the Project's Environment file (review S3 of
   * #150): a Follow-up, and a usage-limit resume inside one (`followUpCount` above zero), work
   * with the Project's current file (or none), snapshotted at the claim as at a Run's start.
   */
  takesNewEnvironmentFile(followUpCount: number): boolean {
    return (
      this.reason === 'follow_up' ||
      this.reason === 'bring_up_to_date' ||
      (this.reason === 'usage_limit' && followUpCount > 0)
    );
  }
}
